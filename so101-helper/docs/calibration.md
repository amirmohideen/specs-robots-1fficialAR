# Calibration inspector

Use the inspector after completing the official LeRobot calibration process to review motor IDs, encoder ranges, offsets, and joint motion envelopes.

## Get a calibration file

Calibrate the SO-101 by following the [official LeRobot SO-101 guide](https://huggingface.co/docs/lerobot/main/en/so101#calibration). Then select the resulting robot calibration JSON in the inspector.

The expected top-level motor keys are:

- `shoulder_pan`
- `shoulder_lift`
- `elbow_flex`
- `wrist_flex`
- `wrist_roll`
- `gripper`

Each entry must contain integer values for `id`, `drive_mode`, `homing_offset`, `range_min`, and `range_max`. See [`schemas/calibration.schema.json`](../schemas/calibration.schema.json) for the machine-readable shape.

## Reading the display

- The pale span represents the encoder travel inferred from `range_min` and `range_max`.
- The colored span represents that travel clipped to the SO-101 physical joint envelope.
- The two thin caps mark the physical low and high limits.
- The center tick marks zero degrees.

The visualization highlights missing motors, duplicate IDs, reversed endpoints, unexpectedly narrow travel, and values outside a single 0–4095 encoder turn.
