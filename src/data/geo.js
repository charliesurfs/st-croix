// Rough one-way drive times between St. Croix areas, in minutes.
// Used by the day-planner + reshuffle engine (Phase 2) to keep days from zigzagging.
export const AREAS = ["Christiansted", "East End", "West End", "Rainforest & North Shore", "Island-wide", "Travel"];

export const DRIVE = {
  "Christiansted":              { "Christiansted": 0,  "East End": 35, "West End": 35, "Rainforest & North Shore": 30 },
  "East End":                   { "Christiansted": 35, "East End": 0,  "West End": 60, "Rainforest & North Shore": 50 },
  "West End":                   { "Christiansted": 35, "East End": 60, "West End": 0,  "Rainforest & North Shore": 18 },
  "Rainforest & North Shore":   { "Christiansted": 30, "East End": 50, "West End": 18, "Rainforest & North Shore": 0  }
};

export function driveTime(a, b) {
  if (!a || !b) return 0;
  return (DRIVE[a] && DRIVE[a][b] != null) ? DRIVE[a][b] : 30;
}

// Sensible default dwell times (minutes) by activity type — tune per activity.
export const DWELL = {
  distillery: 90, museum: 60, garden: 75, beach: 150, snorkel: 90, scuba: 150,
  golf: 270, town_walk: 120, lunch: 60, dinner: 90, scenic_drive: 60, hike: 90, kayak: 90, shopping: 60
};
