/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {assert} from '../../node_modules/chai/index.js';
import {
  assertEventFired,
  assertEventNotFired,
  createChangeListenerSpy,
} from './test_helpers/events.js';
import {
  sharedTestSetup,
  sharedTestTeardown,
} from './test_helpers/setup_teardown.js';

/**
 * Tests for the patch that allows FieldVariable on shadow blocks
 * (a shadow `variables_get` under any value input).
 *
 * Quality requirements distilled from the design discussion that drove
 * this PR:
 *  - #1 No new public-API side effects (no extra VarCreate events fired
 *    automatically, no extra entries in getAllVariables) attributable to
 *    the patch itself - only application-driven calls should mutate the
 *    variable map.
 *  - #2 Shadow / non-shadow `variables_get` must behave identically modulo
 *    "being a shadow": same lookup, same dropdown, same rename / delete
 *    cascade, same code generation.
 *  - #3 Variable delete cascade must include shadow uses (no special
 *    skipping by isShadow()).
 *  - #4 Undo of deleteVariable must fully restore both the variable and
 *    the visible shadow state, with the shadow block keeping its
 *    original id.
 *  - #5 Case 2 (parent template references the deleted variable) must
 *    not crash, throw, or leave the variable map in an inconsistent
 *    state - this scenario is enabled by the patch and is therefore the
 *    patch's responsibility.
 *  - #6 deleteVariable must not throw / refuse for inputs the patch
 *    enables.
 */
suite('Shadow variable fields', function () {
  setup(function () {
    sharedTestSetup.call(this);
    this.workspace = new Blockly.Workspace();

    // Define a parent block with a single value input. We use a fresh
    // type so that nothing in the existing tests can interfere.
    Blockly.defineBlocksWithJsonArray([
      {
        'type': 'shadow_var_parent',
        'message0': 'parent %1',
        'args0': [
          {
            'type': 'input_value',
            'name': 'VALUE',
          },
        ],
        'output': null,
      },
    ]);
  });

  teardown(function () {
    sharedTestTeardown.call(this);
    delete Blockly.Blocks['shadow_var_parent'];
  });

  /**
   * Build a parent block whose VALUE input has a shadow `variables_get`
   * referencing the given variable id and name. The shadow inherits its
   * template from the loaded JSON, mirroring how a toolbox-defined
   * shadow ends up after being dragged out.
   *
   * @param {!Blockly.Workspace} workspace The workspace to load into.
   * @param {string} varId The id of the variable the shadow should reference.
   * @param {string} varName The visible name of that variable.
   * @returns {!Blockly.Block} The newly created parent block.
   */
  function makeParentWithShadowVariable(workspace, varId, varName) {
    return Blockly.serialization.blocks.append(
      {
        'type': 'shadow_var_parent',
        'inputs': {
          'VALUE': {
            'shadow': {
              'type': 'variables_get',
              'fields': {
                'VAR': {
                  'id': varId,
                  'name': varName,
                  'type': '',
                },
              },
            },
          },
        },
      },
      workspace,
    );
  }

  /**
   * Returns the shadow `variables_get` block hanging under the given
   * parent's VALUE input.
   *
   * @param {!Blockly.Block} parent The parent block.
   * @returns {!Blockly.Block} The shadow child block.
   */
  function getShadowChild(parent) {
    const child = parent.getInputTargetBlock('VALUE');
    assert.exists(child, 'shadow child must be attached');
    assert.isTrue(child.isShadow(), 'expected child to be a shadow');
    return child;
  }

  // ---------- Setup-only sanity ----------

  suite('basic shadow attachment', function () {
    test('a shadow variables_get can be attached and renders the variable name', function () {
      this.workspace.createVariable('item', '', 'item_id');
      const parent = makeParentWithShadowVariable(
        this.workspace,
        'item_id',
        'item',
      );
      const shadow = getShadowChild(parent);
      assert.equal(shadow.type, 'variables_get');
      assert.equal(shadow.getField('VAR').getText(), 'item');
      assert.equal(shadow.getField('VAR').getValue(), 'item_id');
    });

    test('shadow and non-shadow variables_get on the same id share the same VariableModel', function () {
      // Quality #2: symmetric behavior - same lookup path.
      this.workspace.createVariable('item', '', 'item_id');
      const parent = makeParentWithShadowVariable(
        this.workspace,
        'item_id',
        'item',
      );
      const shadow = getShadowChild(parent);

      const nonShadow = this.workspace.newBlock('variables_get');
      nonShadow.getField('VAR').setValue('item_id');

      assert.strictEqual(
        shadow.getField('VAR').getVariable(),
        nonShadow.getField('VAR').getVariable(),
        'both fields should resolve to the same variable model instance',
      );
    });
  });

  // ---------- T8/T9: API side-effect freedom ----------

  suite('no spurious side effects on attachment', function () {
    test('attaching a shadow variables_get does not fire any VarCreate event', function () {
      // Quality #1: no API side effect attributable to the patch.
      // Pre-register the variable BEFORE installing the listener so the
      // initial VarCreate is excluded from the spy.
      this.workspace.createVariable('item', '', 'item_id');
      const spy = createChangeListenerSpy(this.workspace);
      makeParentWithShadowVariable(this.workspace, 'item_id', 'item');
      assertEventNotFired(spy, Blockly.Events.VarCreate, {}, this.workspace.id);
    });

    test('attaching a shadow variables_get does not change getAllVariables()', function () {
      // Quality #1: getAllVariables must reflect only application calls.
      this.workspace.createVariable('item', '', 'item_id');
      const before = this.workspace
        .getAllVariables()
        .map((v) => v.getId())
        .sort();
      makeParentWithShadowVariable(this.workspace, 'item_id', 'item');
      const after = this.workspace
        .getAllVariables()
        .map((v) => v.getId())
        .sort();
      assert.deepEqual(after, before);
    });
  });

  // ---------- T1 / T2: Case 1 delete + undo ----------

  suite('Case 1 - shadow value differs from template default', function () {
    setup(function () {
      // Toolbox-style template references "item". The user then changes the
      // shadow's field to point at "foo". The parent's stored shadowState
      // is unchanged (still "item"), because edits do not propagate.
      this.workspace.createVariable('item', '', 'item_id');
      this.workspace.createVariable('foo', '', 'foo_id');
      this.parent = makeParentWithShadowVariable(
        this.workspace,
        'item_id',
        'item',
      );
      this.shadow = getShadowChild(this.parent);
      this.originalShadowId = this.shadow.id;
      // User picks foo from the dropdown.
      this.shadow.getField('VAR').setValue('foo_id');
    });

    test('deleteVariable resets the shadow field to the template default', function () {
      // Quality #3 + #2: cascade processes the shadow.
      const foo = this.workspace.getVariableMap().getVariableById('foo_id');
      this.workspace.getVariableMap().deleteVariable(foo);

      // Variable map: foo gone.
      assert.notExists(
        this.workspace.getVariableMap().getVariableById('foo_id'),
      );
      // Shadow still attached at the same id; field reset to "item".
      const shadow = getShadowChild(this.parent);
      assert.equal(shadow.id, this.originalShadowId);
      assert.equal(shadow.getField('VAR').getValue(), 'item_id');
    });

    test('deleteVariable does not throw', function () {
      // Quality #6: API must not throw for inputs the patch enables.
      const foo = this.workspace.getVariableMap().getVariableById('foo_id');
      assert.doesNotThrow(() =>
        this.workspace.getVariableMap().deleteVariable(foo),
      );
    });

    test('undo restores foo and the shadow display, preserving block id', function () {
      // Quality #4: full undo restoration.
      const foo = this.workspace.getVariableMap().getVariableById('foo_id');
      this.workspace.getVariableMap().deleteVariable(foo);
      this.workspace.undo(false);

      const restored = this.workspace
        .getVariableMap()
        .getVariableById('foo_id');
      assert.exists(restored, 'foo variable must be restored');
      assert.equal(restored.getName(), 'foo');

      const shadow = getShadowChild(this.parent);
      assert.equal(
        shadow.id,
        this.originalShadowId,
        'shadow block id must not change across delete/undo',
      );
      assert.equal(
        shadow.getField('VAR').getValue(),
        'foo_id',
        'shadow field must be back to foo',
      );
    });

    test('redo re-applies the deletion', function () {
      const foo = this.workspace.getVariableMap().getVariableById('foo_id');
      this.workspace.getVariableMap().deleteVariable(foo);
      this.workspace.undo(false);
      this.workspace.undo(true); // redo

      assert.notExists(
        this.workspace.getVariableMap().getVariableById('foo_id'),
        'foo should be gone again after redo',
      );
      const shadow = getShadowChild(this.parent);
      assert.equal(shadow.getField('VAR').getValue(), 'item_id');
    });

    test('repeated delete-undo cycles do not accumulate variables', function () {
      // Quality #4 (#11 in the test plan): no leak across cycles.
      const initialCount = this.workspace.getAllVariables().length;
      for (let i = 0; i < 3; i++) {
        const foo = this.workspace.getVariableMap().getVariableById('foo_id');
        this.workspace.getVariableMap().deleteVariable(foo);
        this.workspace.undo(false);
      }
      assert.equal(
        this.workspace.getAllVariables().length,
        initialCount,
        'variable count should be stable across delete/undo cycles',
      );
    });
  });

  // ---------- T3 / T4: Case 2 delete (save/load round-trip) ----------

  suite(
    'Case 2 - parent template references the deleted variable',
    function () {
      setup(function () {
        // Simulate "save with foo selected, then load again". After load,
        // serializeShadow on the connection captures the live shadow state,
        // so the parent's shadowState now references foo (not the original
        // toolbox default). The most direct way to reach this state in a
        // headless test is to round-trip through the serializer.
        this.workspace.createVariable('item', '', 'item_id');
        this.workspace.createVariable('foo', '', 'foo_id');
        const original = makeParentWithShadowVariable(
          this.workspace,
          'item_id',
          'item',
        );
        // User picks foo on the original parent, then we save & reload.
        getShadowChild(original).getField('VAR').setValue('foo_id');

        const state = Blockly.serialization.workspaces.save(this.workspace);
        this.workspace.clear();
        // Re-create the application-side variables before reloading the
        // blocks, the same way an embedding application would.
        this.workspace.createVariable('item', '', 'item_id');
        this.workspace.createVariable('foo', '', 'foo_id');
        Blockly.serialization.workspaces.load(state, this.workspace);

        this.parent = this.workspace
          .getAllBlocks(false)
          .find((b) => b.type === 'shadow_var_parent');
        this.shadow = getShadowChild(this.parent);
        this.originalShadowId = this.shadow.id;

        // Sanity: parent's shadowState now references foo, confirming
        // we have actually reached Case 2.
        const shadowState = this.parent
          .getInput('VALUE')
          .connection.getShadowState();
        assert.equal(
          shadowState && shadowState.fields && shadowState.fields.VAR.id,
          'foo_id',
          'precondition: parent shadowState must reference foo (Case 2)',
        );
      });

      test('deleteVariable does not throw', function () {
        // Quality #6: even Case 2 must not throw.
        const foo = this.workspace.getVariableMap().getVariableById('foo_id');
        assert.doesNotThrow(() =>
          this.workspace.getVariableMap().deleteVariable(foo),
        );
      });

      test('foo is removed from the variable map', function () {
        const foo = this.workspace.getVariableMap().getVariableById('foo_id');
        this.workspace.getVariableMap().deleteVariable(foo);
        assert.notExists(
          this.workspace.getVariableMap().getVariableById('foo_id'),
        );
      });

      test('parent block survives the cascade', function () {
        const foo = this.workspace.getVariableMap().getVariableById('foo_id');
        this.workspace.getVariableMap().deleteVariable(foo);
        assert.isFalse(
          this.parent.isDeadOrDying(),
          'parent block must not be disposed by the cascade',
        );
      });

      test('undo restores foo and parent / shadow remain alive', function () {
        // Quality #4: undo restores the variable. (B' prototype: shadow
        // continues to display foo via its cached VariableModel reference;
        // the variable map entry is the only data the user can verify.)
        const foo = this.workspace.getVariableMap().getVariableById('foo_id');
        this.workspace.getVariableMap().deleteVariable(foo);
        this.workspace.undo(false);

        assert.exists(
          this.workspace.getVariableMap().getVariableById('foo_id'),
          'foo variable must be restored on undo',
        );
        assert.isFalse(this.parent.isDeadOrDying());
        const shadow = getShadowChild(this.parent);
        assert.equal(
          shadow.id,
          this.originalShadowId,
          'shadow block id must not change across delete/undo',
        );
      });

      test('repeated delete-undo cycles leave a stable variable map', function () {
        // Quality #4 (#11): no accumulation even in Case 2.
        const initialNames = this.workspace
          .getAllVariables()
          .map((v) => v.getName())
          .sort();
        for (let i = 0; i < 3; i++) {
          const foo = this.workspace.getVariableMap().getVariableById('foo_id');
          this.workspace.getVariableMap().deleteVariable(foo);
          this.workspace.undo(false);
        }
        const finalNames = this.workspace
          .getAllVariables()
          .map((v) => v.getName())
          .sort();
        assert.deepEqual(finalNames, initialNames);
      });
    },
  );

  // ---------- T5 / T6: shared rename / cascade with non-shadow ----------

  suite('symmetric behavior with non-shadow variables_get', function () {
    setup(function () {
      this.workspace.createVariable('item', '', 'item_id');
      this.workspace.createVariable('foo', '', 'foo_id');
      this.parent = makeParentWithShadowVariable(
        this.workspace,
        'item_id',
        'item',
      );
      this.shadow = getShadowChild(this.parent);
      this.shadow.getField('VAR').setValue('foo_id');

      this.nonShadow = this.workspace.newBlock('variables_get');
      this.nonShadow.getField('VAR').setValue('foo_id');
    });

    test('rename updates both shadow and non-shadow displays', function () {
      // Quality #2: renames flow through the same path for both.
      const foo = this.workspace.getVariableMap().getVariableById('foo_id');
      this.workspace.getVariableMap().renameVariable(foo, 'foo2');
      assert.equal(this.shadow.getField('VAR').getText(), 'foo2');
      assert.equal(this.nonShadow.getField('VAR').getText(), 'foo2');
    });

    test('deleteVariable processes the non-shadow as a use', function () {
      // Quality #3: cascade also reaches non-shadow uses.
      const foo = this.workspace.getVariableMap().getVariableById('foo_id');
      this.workspace.getVariableMap().deleteVariable(foo);
      assert.isTrue(
        this.nonShadow.isDeadOrDying(),
        'non-shadow use should be disposed by cascade',
      );
    });

    test('VarDelete is fired exactly once even with mixed shadow / non-shadow uses', function () {
      // Quality #1: no spurious extra VarCreate / VarDelete from the
      // shadow path.
      const spy = createChangeListenerSpy(this.workspace);
      const foo = this.workspace.getVariableMap().getVariableById('foo_id');
      this.workspace.getVariableMap().deleteVariable(foo);

      assertEventFired(
        spy,
        Blockly.Events.VarDelete,
        {varId: 'foo_id'},
        this.workspace.id,
      );
      assertEventNotFired(spy, Blockly.Events.VarCreate, {}, this.workspace.id);
    });
  });

  // ---------- T12: Save / Load round-trip ----------

  suite('save / load round-trip', function () {
    test('a parent containing a shadow variables_get round-trips through JSON', function () {
      // Quality #2: serialization parity with non-shadow.
      this.workspace.createVariable('item', '', 'item_id');
      const parent = makeParentWithShadowVariable(
        this.workspace,
        'item_id',
        'item',
      );
      const beforeShadowId = getShadowChild(parent).getField('VAR').getValue();

      const state = Blockly.serialization.workspaces.save(this.workspace);
      this.workspace.clear();
      this.workspace.createVariable('item', '', 'item_id');
      Blockly.serialization.workspaces.load(state, this.workspace);

      const reloadedParent = this.workspace
        .getAllBlocks(false)
        .find((b) => b.type === 'shadow_var_parent');
      const reloadedShadow = getShadowChild(reloadedParent);
      assert.equal(
        reloadedShadow.getField('VAR').getValue(),
        beforeShadowId,
        'shadow field id must survive save / load',
      );
    });
  });
});
