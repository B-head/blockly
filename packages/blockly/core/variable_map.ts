/**
 * @license
 * Copyright 2017 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Object representing a map of variables and their types.
 *
 * @class
 */
// Former goog.module ID: Blockly.VariableMap

// Unused import preserved for side-effects. Remove if unneeded.
import './events/events_var_delete.js';
// Unused import preserved for side-effects. Remove if unneeded.
import './events/events_var_rename.js';

import type {Block} from './block.js';
import {EventType} from './events/type.js';
import * as eventUtils from './events/utils.js';
import {FieldVariable} from './field_variable.js';
import type {IVariableMap} from './interfaces/i_variable_map.js';
import {IVariableModel, IVariableState} from './interfaces/i_variable_model.js';
import {Names} from './names.js';
import * as registry from './registry.js';
import type {State as BlockState} from './serialization/blocks.js';
import * as deprecation from './utils/deprecation.js';
import * as idGenerator from './utils/idgenerator.js';
import * as Variables from './variables.js';
import {deleteVariable, getVariableUsesById} from './variables.js';
import type {Workspace} from './workspace.js';

/**
 * Class for a variable map.  This contains a dictionary data structure with
 * variable types as keys and lists of variables as values.  The list of
 * variables are the type indicated by the key.
 */
export class VariableMap
  implements IVariableMap<IVariableModel<IVariableState>>
{
  /**
   * A map from variable type to map of IDs to variables. The maps contain
   * all of the named variables in the workspace, including variables that are
   * not currently in use.
   */
  private variableMap = new Map<
    string,
    Map<string, IVariableModel<IVariableState>>
  >();

  /**
   * @param workspace The workspace this map belongs to.
   * @param potentialMap True if this holds variables that don't exist in the
   *  workspace yet.
   */
  constructor(
    public workspace: Workspace,
    public potentialMap = false,
  ) {}

  /** Clear the variable map.  Fires events for every deletion. */
  clear() {
    for (const variables of this.variableMap.values()) {
      for (const variable of variables.values()) {
        this.deleteVariable(variable);
      }
    }
    if (this.variableMap.size !== 0) {
      throw Error('Non-empty variable map');
    }
  }

  /* Begin functions for renaming variables. */
  /**
   * Rename the given variable by updating its name in the variable map.
   *
   * @param variable Variable to rename.
   * @param newName New variable name.
   * @returns The newly renamed variable.
   */
  renameVariable(
    variable: IVariableModel<IVariableState>,
    newName: string,
  ): IVariableModel<IVariableState> {
    if (variable.getName() === newName) return variable;
    const type = variable.getType();
    const conflictVar = this.getVariable(newName, type);
    const blocks = this.workspace.getAllBlocks(false);
    let existingGroup = '';
    if (!this.potentialMap) {
      existingGroup = eventUtils.getGroup();
      if (!existingGroup) {
        eventUtils.setGroup(true);
      }
    }
    try {
      // The IDs may match if the rename is a simple case change (name1 ->
      // Name1).
      if (!conflictVar || conflictVar.getId() === variable.getId()) {
        this.renameVariableAndUses(variable, newName, blocks);
      } else {
        this.renameVariableWithConflict(variable, newName, conflictVar, blocks);
      }
    } finally {
      if (!this.potentialMap) eventUtils.setGroup(existingGroup);
    }
    return variable;
  }

  changeVariableType(
    variable: IVariableModel<IVariableState>,
    newType: string,
  ): IVariableModel<IVariableState> {
    const oldType = variable.getType();
    if (oldType === newType) return variable;

    const oldTypeVariables = this.variableMap.get(oldType);
    oldTypeVariables?.delete(variable.getId());
    if (oldTypeVariables?.size === 0) {
      this.variableMap.delete(oldType);
    }
    variable.setType(newType);
    const newTypeVariables =
      this.variableMap.get(newType) ??
      new Map<string, IVariableModel<IVariableState>>();
    newTypeVariables.set(variable.getId(), variable);
    if (!this.variableMap.has(newType)) {
      this.variableMap.set(newType, newTypeVariables);
    }
    eventUtils.fire(
      new (eventUtils.get(EventType.VAR_TYPE_CHANGE))(
        variable,
        oldType,
        newType,
      ),
    );
    return variable;
  }

  /**
   * Rename a variable by updating its name in the variable map. Identify the
   * variable to rename with the given ID.
   *
   * @deprecated v12: use VariableMap.renameVariable.
   * @param id ID of the variable to rename.
   * @param newName New variable name.
   */
  renameVariableById(id: string, newName: string) {
    deprecation.warn(
      'VariableMap.renameVariableById',
      'v12',
      'v13',
      'VariableMap.renameVariable',
    );
    const variable = this.getVariableById(id);
    if (!variable) {
      throw Error("Tried to rename a variable that didn't exist. ID: " + id);
    }

    this.renameVariable(variable, newName);
  }

  /**
   * Update the name of the given variable and refresh all references to it.
   * The new name must not conflict with any existing variable names.
   *
   * @param variable Variable to rename.
   * @param newName New variable name.
   * @param blocks The list of all blocks in the workspace.
   */
  private renameVariableAndUses(
    variable: IVariableModel<IVariableState>,
    newName: string,
    blocks: Block[],
  ) {
    if (!this.potentialMap) {
      eventUtils.fire(
        new (eventUtils.get(EventType.VAR_RENAME))(variable, newName),
      );
    }
    variable.setName(newName);
    for (let i = 0; i < blocks.length; i++) {
      blocks[i].updateVarName(variable);
    }
  }

  /**
   * Update the name of the given variable to the same name as an existing
   * variable.  The two variables are coalesced into a single variable with the
   * ID of the existing variable that was already using newName. Refresh all
   * references to the variable.
   *
   * @param variable Variable to rename.
   * @param newName New variable name.
   * @param conflictVar The variable that was already using newName.
   * @param blocks The list of all blocks in the workspace.
   */
  private renameVariableWithConflict(
    variable: IVariableModel<IVariableState>,
    newName: string,
    conflictVar: IVariableModel<IVariableState>,
    blocks: Block[],
  ) {
    const type = variable.getType();
    const oldCase = conflictVar.getName();

    if (newName !== oldCase) {
      // Simple rename to change the case and update references.
      this.renameVariableAndUses(conflictVar, newName, blocks);
    }

    // These blocks now refer to a different variable.
    // These will fire change events.
    for (let i = 0; i < blocks.length; i++) {
      blocks[i].renameVarById(variable.getId(), conflictVar.getId());
    }
    if (!this.potentialMap) {
      // Finally delete the original variable, which is now unreferenced.
      eventUtils.fire(new (eventUtils.get(EventType.VAR_DELETE))(variable));
    }
    // And remove it from the map.
    this.variableMap.get(type)?.delete(variable.getId());
  }

  /* End functions for renaming variables. */
  /**
   * Create a variable with a given name, optional type, and optional ID.
   *
   * @param name The name of the variable. This must be unique across variables
   *     and procedures.
   * @param opt_type The type of the variable like 'int' or 'string'.
   *     Does not need to be unique. Field_variable can filter variables based
   * on their type. This will default to '' which is a specific type.
   * @param opt_id The unique ID of the variable. This will default to a UUID.
   * @returns The newly created variable.
   */
  createVariable(
    name: string,
    opt_type?: string,
    opt_id?: string,
  ): IVariableModel<IVariableState> {
    let variable = this.getVariable(name, opt_type);
    if (variable) {
      if (opt_id && variable.getId() !== opt_id) {
        throw Error(
          'Variable "' +
            name +
            '" is already in use and its id is "' +
            variable.getId() +
            '" which conflicts with the passed in ' +
            'id, "' +
            opt_id +
            '".',
        );
      }
      // The variable already exists and has the same ID.
      return variable;
    }
    if (opt_id && this.getVariableById(opt_id)) {
      throw Error('Variable id, "' + opt_id + '", is already in use.');
    }
    const id = opt_id || idGenerator.genUid();
    const type = opt_type || '';
    const VariableModel = registry.getClassFromOptions(
      registry.Type.VARIABLE_MODEL,
      this.workspace.options,
      true,
    );
    if (!VariableModel) {
      throw new Error('No variable model is registered.');
    }
    variable = new VariableModel(this.workspace, name, type, id);

    const variables =
      this.variableMap.get(type) ??
      new Map<string, IVariableModel<IVariableState>>();
    variables.set(variable.getId(), variable);
    if (!this.variableMap.has(type)) {
      this.variableMap.set(type, variables);
    }
    if (!this.potentialMap) {
      eventUtils.fire(new (eventUtils.get(EventType.VAR_CREATE))(variable));
    }
    return variable;
  }

  /**
   * Adds the given variable to this variable map.
   *
   * @param variable The variable to add.
   */
  addVariable(variable: IVariableModel<IVariableState>) {
    const type = variable.getType();
    if (!this.variableMap.has(type)) {
      this.variableMap.set(
        type,
        new Map<string, IVariableModel<IVariableState>>(),
      );
    }
    this.variableMap.get(type)?.set(variable.getId(), variable);
  }

  /* Begin functions for variable deletion. */
  /**
   * Delete a variable and all of its uses without confirmation.
   *
   * @param variable Variable to delete.
   */
  deleteVariable(variable: IVariableModel<IVariableState>) {
    const allUses = getVariableUsesById(this.workspace, variable.getId());

    // For each shadow use we collect Case 1 field resets only. Case 2
    // (parent template references the variable being deleted) is currently
    // *left untouched*: the shadow stays attached to its parent and its
    // FieldVariable retains a reference to the now-orphaned variable model.
    // This is a deliberate prototype limitation - see the project memory
    // for the constraint that blocks a clean Case 2 implementation.
    const case1Resets: Array<{
      field: FieldVariable;
      templateField: AnyDuringMigration;
    }> = [];
    const remainingUses: Block[] = [];
    for (let i = 0; i < allUses.length; i++) {
      const use = allUses[i];
      if (!use.isShadow()) {
        remainingUses.push(use);
        continue;
      }
      const classified = this.classifyShadowUse(use, variable.getId());
      if (!classified) {
        // No parent template / no field name - fall through to dispose.
        remainingUses.push(use);
        continue;
      }
      let anyCase2 = false;
      for (const entry of classified) {
        if (entry.case2) {
          anyCase2 = true;
        } else {
          case1Resets.push({
            field: entry.field,
            templateField: entry.templateField,
          });
        }
      }
      // If a shadow has any Case 2 field we leave the whole shadow alone.
      // (A mixed shadow would need more careful handling than the prototype
      // attempts to provide; in practice variables_get only has one field.)
      if (anyCase2) continue;
    }

    let existingGroup = '';
    if (!this.potentialMap) {
      existingGroup = eventUtils.getGroup();
      if (!existingGroup) {
        eventUtils.setGroup(true);
      }
    }
    // Suppress shadow respawn for the duration of the cascade. Without this,
    // disposing a non-shadow use whose parent input has a shadow template
    // would cause the parent to immediately respawn a new shadow, whose
    // FieldVariable would re-create the very variable being deleted.
    const previousSuppress = this.workspace.suppressShadowRespawn;
    this.workspace.suppressShadowRespawn = true;
    try {
      // Case 1: reset shadow fields to their template defaults.
      // BlockChange events fire inside the event group so they undo cleanly.
      for (let i = 0; i < case1Resets.length; i++) {
        const {field, templateField} = case1Resets[i];
        // Make sure the template's variable exists on the workspace before
        // we point the field at it; otherwise doClassValidation_ would reject
        // the new id.
        const tmpl = Variables.getOrCreateVariablePackage(
          this.workspace,
          templateField['id'],
          templateField['name'],
          templateField['type'] || '',
        );
        field.setValue(tmpl.getId());
      }

      for (let i = 0; i < remainingUses.length; i++) {
        if (remainingUses[i].isDeadOrDying()) continue;
        remainingUses[i].dispose(true);
      }
      const variables = this.variableMap.get(variable.getType());
      if (!variables || !variables.has(variable.getId())) return;
      variables.delete(variable.getId());
      if (!this.potentialMap) {
        eventUtils.fire(new (eventUtils.get(EventType.VAR_DELETE))(variable));
      }
      if (variables.size === 0) {
        this.variableMap.delete(variable.getType());
      }
    } finally {
      // Drain deferred respawns now that the variable has been removed.
      // Done while the event group is still open so the restorations
      // (and any side-effect VarCreate events from their FieldVariables)
      // are bundled with the deletion under a single undo.
      if (!previousSuppress) {
        const deferred = this.workspace.pendingShadowRespawns;
        this.workspace.pendingShadowRespawns = [];
        this.workspace.suppressShadowRespawn = false;
        for (let i = 0; i < deferred.length; i++) {
          const conn = deferred[i] as AnyDuringMigration;
          if (
            conn.disposed ||
            conn.getSourceBlock().isDeadOrDying() ||
            conn.targetBlock()
          ) {
            continue;
          }
          conn.respawnShadow_();
        }
      }
      this.workspace.suppressShadowRespawn = previousSuppress;
      if (!this.potentialMap) {
        eventUtils.setGroup(existingGroup);
      }
    }
  }

  /**
   * Classify each FieldVariable on a shadow use that references the variable
   * being deleted. Returns null if any such field cannot be resolved against
   * the parent template (the caller will then dispose the shadow as a
   * fallback).
   *
   * Each entry's `case2` flag indicates whether the parent template's
   * default for that field is the variable being deleted (Case 2 - needs
   * regeneration) or some other variable (Case 1 - direct reset).
   */
  private classifyShadowUse(
    use: Block,
    deletedVariableId: string,
  ): Array<{
    field: FieldVariable;
    templateField: AnyDuringMigration;
    case2: boolean;
  }> | null {
    const useAny = use as AnyDuringMigration;
    const parentConn =
      (useAny.outputConnection && useAny.outputConnection.targetConnection) ||
      (useAny.previousConnection && useAny.previousConnection.targetConnection);
    if (!parentConn) return null;
    // Use the stored shadowState reference (NOT returnCurrent) so that any
    // mutation we make later affects the connection's stored template.
    const templateState = parentConn.getShadowState
      ? (parentConn.getShadowState() as BlockState | null)
      : null;
    if (!templateState || !templateState.fields) return null;

    const entries: Array<{
      field: FieldVariable;
      templateField: AnyDuringMigration;
      case2: boolean;
    }> = [];
    for (let i = 0; i < use.inputList.length; i++) {
      const fieldRow = use.inputList[i].fieldRow;
      for (let j = 0; j < fieldRow.length; j++) {
        const field = fieldRow[j];
        if (!(field instanceof FieldVariable)) continue;
        if (field.getVariable()?.getId() !== deletedVariableId) continue;
        const fieldName = field.name;
        if (!fieldName) return null;
        const tmplField = (templateState.fields as AnyDuringMigration)[
          fieldName
        ];
        if (!tmplField || !tmplField['id']) return null;
        entries.push({
          field,
          templateField: tmplField,
          case2: tmplField['id'] === deletedVariableId,
        });
      }
    }
    return entries.length > 0 ? entries : null;
  }

  /**
   * Delete a variables by the passed in ID and all of its uses from this
   * workspace. May prompt the user for confirmation.
   *
   * @deprecated v12: use Blockly.Variables.deleteVariable.
   * @param id ID of variable to delete.
   */
  deleteVariableById(id: string) {
    deprecation.warn(
      'VariableMap.deleteVariableById',
      'v12',
      'v13',
      'Blockly.Variables.deleteVariable',
    );
    const variable = this.getVariableById(id);
    if (variable) {
      deleteVariable(this.workspace, variable);
    }
  }

  /* End functions for variable deletion. */
  /**
   * Find the variable by the given name and type and return it.  Return null if
   *     it is not found.
   *
   * @param name The name to check for.
   * @param opt_type The type of the variable.  If not provided it defaults to
   *     the empty string, which is a specific type.
   * @returns The variable with the given name, or null if it was not found.
   */
  getVariable(
    name: string,
    opt_type?: string,
  ): IVariableModel<IVariableState> | null {
    const type = opt_type || '';
    const variables = this.variableMap.get(type);
    if (!variables) return null;

    return (
      [...variables.values()].find((variable) =>
        Names.equals(variable.getName(), name),
      ) ?? null
    );
  }

  /**
   * Find the variable by the given ID and return it.  Return null if not found.
   *
   * @param id The ID to check for.
   * @returns The variable with the given ID.
   */
  getVariableById(id: string): IVariableModel<IVariableState> | null {
    for (const variables of this.variableMap.values()) {
      if (variables.has(id)) {
        return variables.get(id) ?? null;
      }
    }
    return null;
  }

  /**
   * Get a list containing all of the variables of a specified type. If type is
   *     null, return list of variables with empty string type.
   *
   * @param type Type of the variables to find.
   * @returns The sought after variables of the passed in type. An empty array
   *     if none are found.
   */
  getVariablesOfType(type: string | null): IVariableModel<IVariableState>[] {
    type = type || '';
    const variables = this.variableMap.get(type);
    if (!variables) return [];

    return [...variables.values()];
  }

  /**
   * Returns a list of unique types of variables in this variable map.
   *
   * @returns A list of unique types of variables in this variable map.
   */
  getTypes(): string[] {
    return [...this.variableMap.keys()];
  }

  /**
   * Return all variables of all types.
   *
   * @returns List of variable models.
   */
  getAllVariables(): IVariableModel<IVariableState>[] {
    let allVariables: IVariableModel<IVariableState>[] = [];
    for (const variables of this.variableMap.values()) {
      allVariables = allVariables.concat(...variables.values());
    }
    return allVariables;
  }

  /**
   * Returns all of the variable names of all types.
   *
   * @deprecated v12: use Blockly.Variables.getAllVariables.
   * @returns All of the variable names of all types.
   */
  getAllVariableNames(): string[] {
    deprecation.warn(
      'VariableMap.getAllVariableNames',
      'v12',
      'v13',
      'Blockly.Variables.getAllVariables',
    );
    const names: string[] = [];
    for (const variables of this.variableMap.values()) {
      for (const variable of variables.values()) {
        names.push(variable.getName());
      }
    }
    return names;
  }

  /**
   * Find all the uses of a named variable.
   *
   * @deprecated v12: use Blockly.Variables.getVariableUsesById.
   * @param id ID of the variable to find.
   * @returns Array of block usages.
   */
  getVariableUsesById(id: string): Block[] {
    deprecation.warn(
      'VariableMap.getVariableUsesById',
      'v12',
      'v13',
      'Blockly.Variables.getVariableUsesById',
    );
    return getVariableUsesById(this.workspace, id);
  }
}

registry.register(registry.Type.VARIABLE_MAP, registry.DEFAULT, VariableMap);
