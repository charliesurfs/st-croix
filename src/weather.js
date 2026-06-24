// Open-Meteo — free, no API key, CORS-friendly. Christiansted, St. Croix by default.
const STX = { lat: 17.747, lng: -64.703 };

export async function getWeather(lat = STX.lat, lng = STX.lng) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=America%2FSt_Thomas&forecast_days=7&temperature_unit=fahrenheit`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("weather fetch failed");
  return r.json();
}

// WMO weather codes → a small icon + label
export function wcode(code) {
  if (code === 0) return { i: "☀️", t: "Clear" };
  if (code <= 2) return { i: "🌤️", t: "Mostly sunny" };
  if (code === 3) return { i: "☁️", t: "Cloudy" };
  if (code <= 48) return { i: "🌫️", t: "Fog" };
  if (code <= 57) return { i: "🌦️", t: "Drizzle" };
  if (code <= 67) return { i: "🌧️", t: "Rain" };
  if (code <= 77) return { i: "🌨️", t: "Snow" };
  if (code <= 82) return { i: "🌧️", t: "Showers" };
  if (code <= 99) return { i: "⛈️", t: "Storms" };
  return { i: "🌡️", t: "—" };
}
