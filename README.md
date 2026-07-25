# Travel Companion

A fast, mobile-first PWA for viewing a shared trip itinerary.

The app is centred on one continuous, vertically scrollable itinerary with sticky day navigation, representative place images, inline travel details, a floating half-height map, and direct Google Maps handoff for navigation.

Trip data is imported from Wanderlog using `wanderlog-cli` JSON, with saved-page MobX state extraction as a backup. Raw Wanderlog data is normalised into a privacy-safe, versioned `TripBundle` before publishing.

The initial implementation is read-only and statically hosted. Installed clients receive itinerary updates through immutable trip revisions and a small manifest. A lightweight live-editing backend may be added later without changing the client data contract.

See [docs/project-spec.md](docs/project-spec.md) for the full architecture, implementation guidance, and anti-patterns.