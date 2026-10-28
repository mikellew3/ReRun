# Forward test

One file per week (`<season>-W<week>.jsonl`), written by `jobs/recordForward.ts` on every snapshot
publish: the sim's chances (default settings) on each book's current line for games kicking off
within `forwardTest.recordWithinHours`, replacing that game's earlier record. So once a game
kicks off, its rows are the last numbers before kickoff.

`pipeline/grade_forward.py` grades played games into `docs/forward-test.json`.
