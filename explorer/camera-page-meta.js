/**
 * Parse camera Make / Model from an iNaturalist photo page HTML body.
 * The site renders EXIF-derived rows via `metadata_table_rows` as <tr><th>…</th><td class="ui">…</td></tr>.
 * @param {string} html
 * @returns {?{ make: string, model: string }}
 */
export function parseCameraMakeModelFromPhotoPageHtml(html) {
  if (!html || typeof html !== "string") return null;
  const strip = (s) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const cell = (label) => {
    const re = new RegExp(
      `<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`,
      "i"
    );
    const m = html.match(re);
    return m ? strip(m[1]) : "";
  };
  const make = cell("Make");
  const model = cell("Model");
  if (!make && !model) return null;
  return { make, model };
}
