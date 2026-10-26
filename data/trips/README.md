Store each trip's hand-copied timetables in `<public-id>/timetables.json`.
Name each trip folder with its public id (`bundle.tripId`), never its private Wanderlog id.
Copy times from official sources only, and record each source URL in the timetable.

Regional files can sit beside it in `<public-id>/timetables/*.json`; all are read. Each file is an array of tables, one per service and direction (see `CuratedTimetable` in `packages/trip-normaliser/src/curated-timetables.ts`). Three optional fields widen what a table can do:

- `stopCoordinates`: `[latitude, longitude]` for each stop key. With them, a board can be built from the table alone when the route planner has nothing (buses NAVITIME's plan doesn't know): a stop within 1.2 km of each end of the leg.
- `valid`: `{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }`, the dates a seasonal timetable runs.
- `allDay: true`: the table lists every departure of the day. Only such tables make a "through the day" board for a leg with no planned time; a table copied around one planned time must not claim it.
