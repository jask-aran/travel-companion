import type { LodgingItem, Place, TripBundle } from "@travel-companion/trip-schema";

export type Stay = {
  key: string;
  name: string;
  placeId?: string;
  checkInDate: string;
  checkOutDate: string;
  notes?: string;
};

export type LodgingRole = "check-out" | "check-in" | "morning" | "evening" | "stay";

export type LodgingSlot = {
  role: LodgingRole;
  stay: Stay;
};

export type DayLodgingPlan = {
  start: LodgingSlot[];
  end: LodgingSlot[];
};

/**
 * Unique stays from lodging items (hotels section emits check-in/out edges).
 * Requires checkInDate + checkOutDate on the items.
 */
export function collectStays(bundle: TripBundle): Stay[] {
  const map = new Map<string, Stay>();

  for (const day of bundle.days) {
    for (const item of day.items) {
      if (item.type !== "lodging") continue;
      const checkInDate = item.checkInDate;
      const checkOutDate = item.checkOutDate;
      if (!checkInDate || !checkOutDate) continue;

      const key =
        item.sourceBlockId !== undefined
          ? `block:${item.sourceBlockId}`
          : `${checkInDate}|${checkOutDate}|${item.name}`;

      const existing = map.get(key);
      if (existing) {
        if (!existing.notes && item.notes) existing.notes = item.notes;
        if (!existing.placeId && item.placeId) existing.placeId = item.placeId;
        continue;
      }

      const stay: Stay = {
        key,
        name: item.name,
        checkInDate,
        checkOutDate,
      };
      if (item.placeId) stay.placeId = item.placeId;
      if (item.notes) stay.notes = item.notes;
      map.set(key, stay);
    }
  }

  return [...map.values()];
}

/**
 * Day bookends:
 * - First day: no morning prior stay; check-in at start if any; evening at end.
 * - Last day: check-out at start if any; no evening.
 * - Transition day (check-out and/or check-in): both edges at start, evening at end if any.
 * - Continuing day: morning (slept last night) at start, evening (sleep tonight) at end.
 */
export function planDayLodging(
  dayDate: string,
  stays: Stay[],
  tripStart: string,
  tripEnd: string,
): DayLodgingPlan {
  const isFirst = dayDate === tripStart;
  const isLast = dayDate === tripEnd;

  const checkOuts = stays.filter((stay) => stay.checkOutDate === dayDate);
  const checkIns = stays.filter((stay) => stay.checkInDate === dayDate);
  const isTransition = checkOuts.length > 0 || checkIns.length > 0;

  // Woke here: in-house this morning (includes checkout morning).
  const morning = stays.find(
    (stay) => stay.checkInDate < dayDate && stay.checkOutDate >= dayDate,
  );
  // Sleep here tonight: still checked in after today starts, leaves after today.
  const evening = stays.find(
    (stay) => stay.checkInDate <= dayDate && stay.checkOutDate > dayDate,
  );

  const start: LodgingSlot[] = [];
  const end: LodgingSlot[] = [];

  if (isTransition) {
    for (const stay of checkOuts) start.push({ role: "check-out", stay });
    for (const stay of checkIns) start.push({ role: "check-in", stay });
  } else if (!isFirst && morning) {
    start.push({ role: "morning", stay: morning });
  }

  if (!isLast && evening) {
    end.push({ role: "evening", stay: evening });
  }

  return { start, end };
}

export function stayPlace(bundle: TripBundle, stay: Stay): Place | undefined {
  if (!stay.placeId) return undefined;
  return bundle.places[stay.placeId];
}

/** Synthetic lodging item for card rendering from a planned slot. */
export function slotToLodgingItem(slot: LodgingSlot): LodgingItem {
  const phase =
    slot.role === "check-out"
      ? "check-out"
      : slot.role === "check-in"
        ? "check-in"
        : "stay";

  const item: LodgingItem = {
    id: `lodging:${slot.role}:${slot.stay.key}`,
    type: "lodging",
    name: slot.stay.name,
    checkInDate: slot.stay.checkInDate,
    checkOutDate: slot.stay.checkOutDate,
    phase,
  };
  if (slot.stay.placeId) item.placeId = slot.stay.placeId;
  if (slot.stay.notes) item.notes = slot.stay.notes;
  return item;
}

/**
 * Flatten a day's lodging into the summary list.
 *
 * A day where you check in produces both a `check-in` slot and an `evening`
 * ("Tonight") slot for the same stay; a day where you check out produces both
 * `check-out` and `morning`. While these sat at opposite ends of the day the
 * repetition was invisible — collected into one summary block it reads as the
 * same hotel listed twice, so keep only the more informative edge.
 */
export function daySummarySlots(plan: DayLodgingPlan): LodgingSlot[] {
  const slots = [...plan.start, ...plan.end];

  // A day in the middle of a stay yields "Woke here" and "Tonight" for the
  // same hotel. Side by side in one block that is the same fact twice, so
  // collapse it to a single band.
  const isMidStay =
    slots.length === 2 &&
    slots[0]?.stay.key === slots[1]?.stay.key &&
    slots.every((slot) => slot.role === "morning" || slot.role === "evening");
  const firstSlot = slots[0];
  if (isMidStay && firstSlot) return [{ role: "stay", stay: firstSlot.stay }];

  const edgeKeys = new Set(
    slots
      .filter((slot) => slot.role === "check-in" || slot.role === "check-out")
      .map((slot) => slot.stay.key),
  );

  return slots.filter((slot) => {
    const isSofterRole = slot.role === "morning" || slot.role === "evening";
    return !(isSofterRole && edgeKeys.has(slot.stay.key));
  });
}
