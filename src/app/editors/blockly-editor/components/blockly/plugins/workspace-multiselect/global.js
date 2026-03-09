/**
 * @license
 * Copyright 2022 MIT
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Global data structure.
 */

import * as Blockly from 'blockly/core';

/**
 * Weakmap for storing multidraggable objects for a given workspace (as a key).
 */
export const multiDraggableWeakMap = new WeakMap();

/**
 * Set for storing the current selected blockSvg ids.
 */
export const dragSelectionWeakMap = new WeakMap();

/**
 * Store the current selection mode.
 */
export const inMultipleSelectionModeWeakMap = new WeakMap();

/**
 * Store the multi-select controls instances.
 */
export const multiselectControlsList = new Set();

/**
 * Store the copy data.
 */
export const copyData = new Set();

/**
 * Store the paste shortcut mode.
 */
export const inPasteShortcut = new WeakMap();

/**
 * Store the copied connections list.
 */
export const connectionDBList = [];

/**
 * Store the registered context menu list.
 */
export const registeredContextMenu = [];

/**
 * Store the registered shortcut list.
 */
export const registeredShortcut = [];

/**
 * Store the copy time.
 */
let timestamp = 0;

// TODO: Update custom enum below into actual enum
//  if plugin is updated to TypeScript.
/**
 * Object holding the names of the default shortcut items.
 */
export const shortcutNames = Object.freeze({
  MULTIDELETE: 'multiselectDelete',
  MULTICOPY: 'multiselectCopy',
  MULTICUT: 'multiselectCut',
  MULTIPASTE: 'multiselectPaste',
});

/**
 * Check if the current selected blockSvg set already contains the parents.
 * @param {!Blockly.BlockSvg} block to check.
 * @param {boolean} move Whether or not in moving.
 * @returns {boolean} true if the block's parents are selected.
 */
export const hasSelectedParent = function(block, move = false) {
  while (block) {
    if (move) {
      block = block.getParent();
    } else {
      block = block.getSurroundParent();
    }

    if (block && dragSelectionWeakMap.get(block.workspace).has(block.id)) {
      return true;
    }
  }
  return false;
};

/**
 * Returns the corresponding object related to the id in the workspace.
 * Currently only supports blocks and workspace comments
 * @param {!Blockly.Workspace} workspace to check.
 * @param {string} id The ID of the object
 * @returns {Blockly.IDraggable} The object that is draggable
 */
export const getByID = function(workspace, id) {
  // TODO: Need to figure our if there is a way to determine
  // type of draggable just from ID, or if we have to pass into
  // getById functions for each type
  if (workspace.getBlockById(id)) {
    return workspace.getBlockById(id);
  } else if (workspace.getCommentById(id)) {
    return workspace.getCommentById(id);
  }
  return null;
};

/**
 * Store copy information for blocks in localStorage.
 */
export const dataCopyToStorage = function() {
  const storage = [];
  copyData.forEach((data) => {
    delete data['source'];
    storage.push(data);
  });
  timestamp = Date.now();
  localStorage.setItem('blocklyStashMulti', JSON.stringify(storage));
  localStorage.setItem('blocklyStashConnection',
      JSON.stringify(connectionDBList));
  localStorage.setItem('blocklyStashTime', timestamp);
};

/**
 * Get copy information for blocks from localStorage.
 */
export const dataCopyFromStorage = function() {
  const storage = JSON.parse(localStorage.getItem('blocklyStashMulti'));
  const connection = JSON.parse(localStorage.getItem('blocklyStashConnection'));
  const time = localStorage.getItem('blocklyStashTime');
  if (storage && parseInt(time) > timestamp) {
    timestamp = time;
    copyData.clear();
    storage.forEach((data) => {
      copyData.add(data);
    });
    connectionDBList.length = 0;
    connection.forEach((data) => {
      connectionDBList.push(data);
    });
  }
};

/**
 * Get blocks number in the clipboard from localStorage.
 * @param {boolean} useCopyPasteCrossTab Whether or not to use
 *     cross tab copy/paste.
 * @returns {number} The number of blocks in the clipboard.
 */
export const blockNumGetFromStorage = function(useCopyPasteCrossTab) {
  if (!useCopyPasteCrossTab) {
    return copyData.size;
  }
  const storage = JSON.parse(localStorage.getItem('blocklyStashMulti'));
  const time = localStorage.getItem('blocklyStashTime');
  if (storage && parseInt(time) > timestamp) {
    return storage.length;
  }
  return copyData.size;
};

/**
 * Get the next available name by incrementing trailing number.
 * @param {string} name The current field value.
 * @param {!Blockly.Workspace} workspace The workspace to check against.
 * @param {string} fieldName The field name to check.
 * @returns {string} The next available name.
 */
const getNextAvailableName = function(name, workspace, fieldName) {
  const match = name.match(/^(.*?)(\d+)$/);
  let baseName, num;
  if (match) {
    baseName = match[1];
    num = parseInt(match[2], 10);
  } else {
    baseName = name;
    num = 1;
  }

  // Collect existing field_input values with the same field name
  const existingValues = new Set();
  const allBlocks = workspace.getAllBlocks(false);
  for (const block of allBlocks) {
    for (const input of block.inputList || []) {
      for (const field of input.fieldRow || []) {
        if (field instanceof Blockly.FieldTextInput &&
            field.name === fieldName) {
          existingValues.add(field.getValue());
        }
      }
    }
  }

  if (!existingValues.has(name)) {
    return name;
  }

  let nextNum = num + 1;
  let candidate = baseName + nextNum;
  while (existingValues.has(candidate)) {
    nextNum++;
    candidate = baseName + nextNum;
  }
  return candidate;
};

/**
 * Increment field_input (FieldTextInput) values on a pasted/duplicated block
 * to generate unique names and avoid duplicates.
 * @param {!Blockly.Block} block The newly pasted/duplicated block.
 * @param {!Blockly.Workspace} workspace The target workspace.
 */
export const incrementFieldInputValues = function(block, workspace) {
  if (!block || !workspace) return;

  const descendants = block.getDescendants ?
      block.getDescendants(false) : [block];

  for (const b of descendants) {
    for (const input of b.inputList || []) {
      for (const field of input.fieldRow || []) {
        if (field instanceof Blockly.FieldTextInput) {
          const currentValue = field.getValue();
          const newValue = getNextAvailableName(
              currentValue, workspace, field.name);
          if (newValue !== currentValue) {
            field.setValue(newValue);
          }
        }
      }
    }
  }
};
