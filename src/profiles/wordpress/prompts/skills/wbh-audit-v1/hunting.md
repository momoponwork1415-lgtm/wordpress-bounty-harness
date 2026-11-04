# Phase 2: focused hunting and gap critics

Root assigns the `planned` units in `REGISTRY.md` to short-lived hunters. A hunter may take nearby units in one feature and boundary; do not combine unrelated boundaries merely to use fewer children. Give it the current map rows, source starting points, exact units, relevant sections of `wordpress-classes.md`, prior open-edge pointers, and the generated Finding / Lead output contract. State the excluded classes and why. The hunter reads current source and writes only under `/workspace/research/agents/<id>/`.

## Hunter's source question

For each unit, identify the low-trust principal, entry and input it controls, the strongest guard that should stop the value or action, the transformations and copies, and the first in-scope effect. Read the pinned WordPress implementation of a claimed capability, nonce, escaping or query-preparation guard rather than trusting its name. Compare alternate callers, plugin wrappers and read-back paths that can reach the same effect. When input is stored, trace both the writer and the later reader; a safe write is not proof of safe later use.

Stop a line when the boundary is settled by a source-visible guard, when an effect is supported, or when an exact missing edge is named. Test plausible type and encoding differences and normal failure branches only where the interface accepts them. Follow a longer chain only when each prerequisite is source-backed. Do not infer a stronger effect from an error, a handler name or a tool match. A route outside the assigned unit becomes an `uncovered` pointer for Root to assign; the hunter does not silently expand its scope.

Write one JSON scratch result per hunter. It has `units` (one result for every assigned unit: ID, `checked|candidate|blocked`, current `file:line` source checks with the guard or effect each establishes, route-file pointer when any, and exact unresolved fact), plus `uncovered` (source-backed entry or boundary outside the assignment). A checked result needs a real read of the handler to its guard or effect. A blocked result needs the source read so far and the missing fact. The hunter's final message follows the generated four-key JSON contract with empty `findings` and `leads`; name its scratch result in `examined` and unfinished units in `unexamined`. Only Root's final report emits claim objects after Phase 5. Root rejects a missing assigned unit, an unsupported source location, or a state with no required check and assigns that unit again or defers it with the exact reason.

## Route record

Root transfers a hunter's source-grounded route to `/workspace/research/routes/<unit>.md` and links it in `REGISTRY.md`. Keep one path per record or an explicit variant section for the same cause. Record:

| Field | What to write |
| --- | --- |
| Unit and origin | Current work unit and any supplied prior pointer; old evidence is marked old. |
| Root-cause fingerprint | Stable source-derived identity of the component, missing or incorrect control, crossed boundary and effect. Exclude line, version, wave, child, verdict and severity. Reuse a prior fingerprint only after current-source comparison. |
| Attacker side | Entry registration and resolved handler, role, input parameter or field, each with current file and line. |
| Boundary | Current capability, nonce, ownership, validation, escaping and query-preparation checks on this path, including the strongest preventing layer. |
| Producer | Each transformation, writer and store location; if unknown, the next writer/caller to read. |
| Consumer | Store reader, later transformation, PHP or JavaScript output / SQL / other in-scope effect, with current file and line. |
| Lab | Exact question or reference to `lab-facts.md`, plus what the observation does and does not establish. |
| State | Supported chain, refuted premise or exact open edge and next action. |

For a producer gap, start at the store write or the stored value's reader and trace callers backward until the entry, reachable role and input field are known. If the source names no reachable writer, record the missing caller or dependency; do not call it a Lab question. For a read-back gap, find the code and role that loads the value before assuming the saved form reaches the sink. Once the entry, role and parameter are concrete, the Lab question can be sent to `wbh-lab` when installed.

Root keeps `REGISTRY.md` as the index of units, routes and next actions. Do not duplicate full route prose in the registry. Consolidate routes by fingerprint and then check that they truly share one root cause; several entry variants of one missing control become one candidate with the strongest complete trace, while different missing controls keep distinct fingerprints. A duplicate fingerprint is a link to the primary route, not another validation assignment. Keep a candidate whose chain is complete and a Lead whose one missing edge remains distinct; the generated schemas decide which claim object can eventually be emitted. The fingerprint stays in research files because the generated Finding / Lead schema does not define a fingerprint field.

## Fresh gap critic after each wave

After each hunter wave, ask a new child that did not hunt those units to read current source near request registrations, shared dispatch wrappers, store readers, effect helpers, SQL construction, PHP output and shipped browser renderers. Give it the map, registry, route pointers, literal tool hints if present and the staged prior gaps. It checks for an unmapped entry, a parallel writer or reader, an unchecked lifecycle mode, a unit marked checked without its source and control check, and a prior unresolved edge that no current unit addresses. It also makes one class-blind pass over source-visible fallback, compatibility and less-used entries, and one literal pass over exposed handlers and obvious dangerous effects as `wordpress-classes.md` describes. It proposes source-backed new units or reopens; it does not declare a finding.

The critic writes one JSON scratch result with `missing_units` (source location, boundary, class and reason), `reopen` (existing ID, source location and reason), and `no_new_work` (its assessment after those lists). Its final four-key JSON has empty `findings` and `leads`. Root checks each proposal in source and updates the map and registry. In `quick`, mark accepted new or reopened work deferred with the quick depth as the reason; do not silently start a second wave. In `standard` and `deep`, assign it to a fresh hunter in another wave and preserve the previous attempt when reopening. Repeat until a critic opens no actionable source-backed work or the Trial wall/budget prevents another wave; after such a no-new-work pass, use a different fresh critic for the final check. Root's accepted source-backed work, not the critic's `no_new_work` alone, controls the next wave. A critic's silence is bounded to what it read, not a guarantee of complete coverage. Unassigned work remains `deferred` or `blocked` with its actual reason.
