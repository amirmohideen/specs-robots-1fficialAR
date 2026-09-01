// Canonical physical-part palette. Keep baseHex values synchronized with
// MechanicalAssemblyOperations.ts; the Node suite enforces exact parity.
export const ASSEMBLY_PALETTE = Object.freeze({
  structure: Object.freeze({ baseHex: '#173D49', value: 0x173D49 }),
  mount: Object.freeze({ baseHex: '#167F93', value: 0x167F93 }),
  actuator: Object.freeze({ baseHex: '#2EB5C7', value: 0x2EB5C7 }),
  fastener: Object.freeze({ baseHex: '#EC7859', value: 0xEC7859 }),
});

export function classifyPhysicalPart(value = '') {
  const lower = String(value).toLowerCase();
  if (lower.startsWith('screw/') || lower.includes('fastener')) return 'fastener';
  if (lower.includes('sts3215') || lower.includes('servo')) return 'actuator';
  if (lower.includes('motor_holder') || lower.includes('mounting_plate')) return 'mount';
  return 'structure';
}

export function paletteColorFor(value) {
  return ASSEMBLY_PALETTE[classifyPhysicalPart(value)].value;
}
