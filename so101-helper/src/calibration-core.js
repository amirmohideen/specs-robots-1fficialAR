export const SERVO_MAX_TICK = 4095;

export const JOINTS = [
  { name: 'shoulder_pan', label: 'Shoulder pan', limitsRad: [-1.9198621772, 1.9198621772] },
  { name: 'shoulder_lift', label: 'Shoulder lift', limitsRad: [-1.745329252, 1.745329252] },
  { name: 'elbow_flex', label: 'Elbow flex', limitsRad: [-1.69, 1.69] },
  { name: 'wrist_flex', label: 'Wrist flex', limitsRad: [-1.6580628495, 1.6580627293] },
  { name: 'wrist_roll', label: 'Wrist roll', limitsRad: [-2.743847297, 2.8412063094] },
  { name: 'gripper', label: 'Gripper', limitsRad: [-0.1745329776, 1.7453291996], logicalRange: true },
];

const REQUIRED_FIELDS = ['id', 'drive_mode', 'homing_offset', 'range_min', 'range_max'];
const toDegrees = (radians) => radians * 180 / Math.PI;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

export function inspectCalibration(input) {
  const errors = [];
  const warnings = [];
  const source = input?.motors && typeof input.motors === 'object' ? input.motors : input;

  if (!source || Array.isArray(source) || typeof source !== 'object') {
    return { errors: ['Calibration must be a JSON object keyed by motor name.'], warnings, joints: [] };
  }

  const unknown = Object.keys(source).filter((name) => !JOINTS.some((joint) => joint.name === name));
  if (unknown.length) warnings.push(`Ignored unknown entries: ${unknown.join(', ')}.`);

  const normalized = [];
  for (const joint of JOINTS) {
    const value = source[joint.name];
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      errors.push(`Missing motor “${joint.name}”.`);
      continue;
    }

    const missing = REQUIRED_FIELDS.filter((field) => !(field in value));
    if (missing.length) {
      errors.push(`${joint.name} is missing ${missing.join(', ')}.`);
      continue;
    }

    const entry = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, finiteInteger(value[field])]));
    const invalid = REQUIRED_FIELDS.filter((field) => entry[field] === null);
    if (invalid.length) {
      errors.push(`${joint.name} has non-integer values for ${invalid.join(', ')}.`);
      continue;
    }
    if (entry.range_max <= entry.range_min) {
      errors.push(`${joint.name} has an empty or reversed encoder range.`);
      continue;
    }

    const jointWarnings = [];
    if (entry.id < 1 || entry.id > 253) jointWarnings.push(`Motor ID ${entry.id} is outside the usual Feetech range.`);
    if (![0, 1].includes(entry.drive_mode)) jointWarnings.push(`Drive mode ${entry.drive_mode} is unusual.`);
    if (entry.range_min < 0 || entry.range_max > SERVO_MAX_TICK) jointWarnings.push('Measured endpoints extend beyond one 0–4095 encoder turn.');

    const [physicalMin, physicalMax] = joint.limitsRad.map(toDegrees);
    const physicalSpan = physicalMax - physicalMin;
    const measuredSpan = (entry.range_max - entry.range_min) * 360 / SERVO_MAX_TICK;
    const center = (physicalMin + physicalMax) / 2;
    const measuredMin = center - measuredSpan / 2;
    const measuredMax = center + measuredSpan / 2;
    const usableMin = Math.max(physicalMin, measuredMin);
    const usableMax = Math.min(physicalMax, measuredMax);
    const usableSpan = usableMax - usableMin;

    if (usableSpan <= 0) {
      errors.push(`${joint.name} does not overlap its physical motion envelope.`);
      continue;
    }
    if (!joint.logicalRange && measuredSpan < physicalSpan * 0.7) {
      jointWarnings.push('Measured travel covers less than 70% of the physical envelope. Recheck endpoint calibration.');
    }
    if (measuredSpan > physicalSpan * 1.35) {
      jointWarnings.push('Measured travel is substantially wider than the physical envelope and has been clipped.');
    }

    normalized.push({
      ...joint,
      ...entry,
      physicalMin,
      physicalMax,
      physicalSpan,
      measuredMin,
      measuredMax,
      measuredSpan,
      usableMin,
      usableMax,
      usableSpan,
      warnings: jointWarnings,
      rail: {
        measuredLeft: clamp((measuredMin + 180) / 360 * 100, 0, 100),
        measuredWidth: clamp(measuredSpan / 360 * 100, 0, 100),
        usableLeft: clamp((usableMin + 180) / 360 * 100, 0, 100),
        usableWidth: clamp(usableSpan / 360 * 100, 0, 100),
        minCap: clamp((physicalMin + 180) / 360 * 100, 0, 100),
        maxCap: clamp((physicalMax + 180) / 360 * 100, 0, 100),
      },
    });
  }

  const ids = new Map();
  for (const joint of normalized) {
    const duplicate = ids.get(joint.id);
    if (duplicate) errors.push(`Motor ID ${joint.id} is used by both ${duplicate} and ${joint.name}.`);
    else ids.set(joint.id, joint.name);
  }

  for (const joint of normalized) {
    for (const warning of joint.warnings) warnings.push(`${joint.name}: ${warning}`);
  }

  return { errors, warnings, joints: normalized };
}
