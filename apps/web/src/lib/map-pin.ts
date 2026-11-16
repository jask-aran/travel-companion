import { dayMapVisits, type DayMapData, type MapStop } from "./day-map.js";
import { TRAVEL_ICON_PATHS } from "./travel-icons.js";

export function mapPin(stop: MapStop, data: DayMapData, includeFlights = false): HTMLElement {
  const visits = dayMapVisits(data, includeFlights);
  const first = visits[0];
  const last = visits.at(-1);
  const visit = data.visits.find((item) => item.place.id === stop.place.id);
  const starts = first?.place.id === stop.place.id;
  const finishes = last?.place.id === stop.place.id;
  const pin = document.createElement("div");
  pin.className = "journey-pin";
  pin.dataset.phase = starts && finishes ? "return" : starts ? "start" : finishes ? "finish" : "stop";
  pin.dataset.kind = visit?.kind ?? "poi";
  const badge = document.createElement("span");
  badge.className = "journey-pin__badge";
  if (visit?.kind === "poi" && !starts && !finishes) badge.textContent = stop.labels.join("·");
  else {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", visit?.kind === "poi" ? "M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8ZM8 8a1.6 1.6 0 1 0 0-3.2A1.6 1.6 0 0 0 8 8Z" : TRAVEL_ICON_PATHS[visit?.kind === "hotel" ? "lodging" : visit?.kind === "airport" ? "flight" : "transit"] ?? "");
    svg.append(path);
    badge.append(svg);
    if (visit?.kind === "station" && !starts && !finishes) {
      const number = document.createElement("span");
      number.className = "journey-pin__number";
      number.textContent = stop.labels.join("·");
      badge.append(number);
    }
  }
  const caption = document.createElement("span");
  caption.className = "journey-pin__caption";
  const role = document.createElement("small");
  role.textContent = starts && finishes ? "Start & return" : starts ? "Start" : finishes ? "Finish" : visit?.kind === "poi" ? "Point of interest" : visit?.kind === "hotel" ? "Hotel" : visit?.kind === "airport" ? "Airport" : "Station";
  const name = document.createElement("strong");
  name.textContent = stop.place.name;
  caption.append(role, name);
  pin.append(badge, caption);
  return pin;
}

export function updateMapPin(node: HTMLElement, stop: MapStop, data: DayMapData, whole: boolean): void {
  const next = mapPin(stop, data, whole);
  node.dataset.phase = next.dataset.phase ?? "stop";
  node.replaceChildren(...next.childNodes);
}

export function positionMapPin(node: HTMLElement, x: number, width: number): void {
  node.classList.toggle("journey-pin--edge-left", x < 110);
  node.classList.toggle("journey-pin--edge-right", x > width - 110);
}
