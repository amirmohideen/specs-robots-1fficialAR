import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCalibration } from '../src/calibration-core.js';

const valid = Object.fromEntries(
  ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'].map((name, index) => [name, {
    id: index + 1,
    drive_mode: 0,
    homing_offset: 0,
    range_min: 500,
    range_max: 3500,
  }]),
);

test('accepts a complete LeRobot-style motor map', () => {
  const result = inspectCalibration(valid);
  assert.equal(result.errors.length, 0);
  assert.equal(result.joints.length, 6);
  assert.equal(result.joints[0].name, 'shoulder_pan');
  assert.ok(result.joints[0].usableMax <= result.joints[0].physicalMax);
});

test('reports a missing motor', () => {
  const input = structuredClone(valid);
  delete input.gripper;
  const result = inspectCalibration(input);
  assert.match(result.errors.join(' '), /Missing motor “gripper”/);
});

test('reports duplicate IDs', () => {
  const input = structuredClone(valid);
  input.gripper.id = 1;
  const result = inspectCalibration(input);
  assert.match(result.errors.join(' '), /Motor ID 1 is used by both/);
});

test('warns about a very narrow calibration span', () => {
  const input = structuredClone(valid);
  input.shoulder_pan.range_min = 1900;
  input.shoulder_pan.range_max = 2200;
  const result = inspectCalibration(input);
  assert.match(result.warnings.join(' '), /less than 70%/);
});
