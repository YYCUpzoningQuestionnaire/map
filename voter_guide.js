/* voter_guide.js
   Loads GeoJSON + CSV from known file paths and displays candidate filters on a Leaflet map.
   Place your files in the same folder, e.g.:
   - wards.geojson
   - survey.csv
*/

(async function () {
  "use strict";

  const normalize = (v) => (v == null ? "" : String(v).trim());
  const lc = (s) => s.toLowerCase();

  // --- Load files ---
  async function loadJSON(path) {
    const res = await fetch(path);
    return res.json();
  }
  async function loadCSV(path) {
    const res = await fetch(path);
    const text = await res.text();
    return Papa.parse(text, { skipEmptyLines: "greedy" });
  }

  // --- Survey cleaning ---
  function cleanSurveyFromPapa(papaResult) {
    const data = papaResult.data;
    if (!data.length) return { rows: [], issueColumns: [], wardColumn: null, nameColumn: null };

    const rawHeaders = data[0].map((h) =>
      h == null || String(h).startsWith("Unnamed") ? "" : String(h)
    );
    const headers = [];
    for (let i = 0; i < rawHeaders.length; i++) {
      headers[i] = rawHeaders[i] ? rawHeaders[i] : i > 0 ? headers[i - 1] : "";
    }

    // group indices by header
    const groups = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const key = h.trim();
      if (!groups[key]) groups[key] = [];
      groups[key].push(i);
    });

    const mergedRows = [];
    for (let r = 1; r < data.length; r++) {
      const arr = data[r];
      const obj = {};
      for (const [h, idxs] of Object.entries(groups)) {
        let chosen = "";
        for (const idx of idxs) {
          const v = arr[idx];
          if (v !== undefined && v !== null && String(v).trim() !== "") {
            chosen = typeof v === "string" ? v.trim() : v;
            break;
          }
        }
        obj[h] = chosen;
      }
      if (Object.values(obj).some((v) => normalize(v) !== "")) mergedRows.push(obj);
    }

    const colNames = Object.keys(groups).map((c) => c.trim());
    const nameColumn = colNames.find((c) => /candidate/i.test(c)) || null;
    const wardColumn = colNames.find((c) => /\bward\b/i.test(c)) || null;

    const issueColumns = [];
    const ynu = new Set(["yes", "no", "undecided"]);
    for (const c of colNames) {
      let nonEmpty = 0,
        ynuCount = 0;
      for (const row of mergedRows) {
        const v = normalize(row[c]);
        if (!v) continue;
        nonEmpty++;
        if (ynu.has(lc(v))) ynuCount++;
      }
      if (nonEmpty > 0 && ynuCount / nonEmpty >= 0.7) issueColumns.push(c);
    }

    return { rows: mergedRows, issueColumns, wardColumn, nameColumn };
  }

  // --- Map ---
  const map = L.map("map").setView([51.05, -114.07], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
  }).addTo(map);
  const markerGroup = L.layerGroup().addTo(map);

  const defaultIcon = L.icon({
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
  });

  // --- Main ---
  const geojson = await loadJSON("wards.geojson");   // <--- hardcoded path
  const survey = cleanSurveyFromPapa(await loadCSV("survey.csv"));  // <--- hardcoded path

  L.geoJSON(geojson, { style: { color: "#444", weight: 1, fillOpacity: 0.05 } }).addTo(map);

  // Put markers at ward centroids
  for (const f of geojson.features) {
    const wardName = f.properties.name || f.properties.Ward || f.properties.WARD || "";
    if (!wardName) continue;
    const center = turf.centerOfMass(f);
    const [lng, lat] = center.geometry.coordinates;

    const matches = survey.rows.filter((r) => normalize(r[survey.wardColumn]) === wardName);
    const popup = `<b>${wardName}</b><br> Candidates: ${matches.length}<ul>` +
      matches
        .map(
          (r) =>
            `<li>${normalize(r[survey.nameColumn] || "") || "(name missing)"}</li>`
        )
        .join("") +
      "</ul>";

    L.marker([lat, lng], { icon: defaultIcon }).addTo(markerGroup).bindPopup(popup);
  }
})();
