export const COMPUTER_PROMPT = `Use find or targets first for a known role/name control (cheaper than tree/screenshot); pixels remain available. Coordinates are pixels of its last screenshot; refresh after frame changes. Trees use [n] role "title" value rows. Terminal captures default to accessibility text. fill (target/ref) sets the value and reads it back; fields lists the controls.

The first act of a session asks once; tree/find/read/wait-until share its grant; other reads never ask. Operator typing pauses automation; esc/ctrl+c releases input.

After a click whose effect you assume, wait with until; a sequence stops at its timeout. After the same act twice with an unchanged result, read the screen before acting again.`
