declare const __GOOGLE_MAPS_BROWSER_KEY__: string;
declare const __GOOGLE_MAP_ID__: string;

export const googleMapsKey = typeof __GOOGLE_MAPS_BROWSER_KEY__ === "string" ? __GOOGLE_MAPS_BROWSER_KEY__ : "";
export const googleMapId = typeof __GOOGLE_MAP_ID__ === "string" ? __GOOGLE_MAP_ID__ : "DEMO_MAP_ID";
