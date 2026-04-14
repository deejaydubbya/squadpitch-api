// Content Context Builder — transforms raw data items into structured,
// content-ready context per industry. Sits between data extraction and
// OpenAI generation to produce higher-quality, more specific output.
//
// Each transformer extracts the most content-worthy fields from a data
// item's dataJson and returns a normalized shape the prompt builder can
// inject as structured context instead of dumping raw key/value pairs.

/**
 * Transform a data item into structured content context for generation.
 * Returns null if the item has no usable data.
 *
 * @param {object} dataItem — { type, title, summary, dataJson, tags }
 * @param {string | null} industryKey
 * @returns {{ headline: string, highlights: string[], emotionalHook?: string, pricePoint?: string, location?: string, urgency?: string, authorityTopics?: string[], trustSignals?: string[] } | null}
 */
export function buildContentContext(dataItem, industryKey) {
  if (!dataItem?.dataJson || typeof dataItem.dataJson !== "object") {
    return transformDefault(dataItem);
  }

  try {
    switch (industryKey) {
      case "real_estate":
      case "property_management":
        return transformRealEstate(dataItem);
      case "car_sales":
        return transformCarSales(dataItem);
      case "legal":
        return transformLegal(dataItem);
      case "mortgage":
      case "insurance":
      case "finance":
        return transformFinancialServices(dataItem);
      case "restaurant":
        return transformRestaurant(dataItem);
      case "fitness":
        return transformFitness(dataItem);
      case "ecommerce":
        return transformEcommerce(dataItem);
      default:
        return transformDefault(dataItem);
    }
  } catch {
    // Fallback safety — never crash the pipeline
    return transformDefault(dataItem);
  }
}

// ── Industry Transformers ──────────────────────────────────────────────

function transformRealEstate(item) {
  const d = item.dataJson;
  const beds = d.bedrooms || d.beds;
  const baths = d.bathrooms || d.baths;
  const city = d.city || d.location || "";
  const state = d.state || "";
  const location = [city, state].filter(Boolean).join(", ");

  const headline = beds && baths
    ? `${beds} Bed / ${baths} Bath Home${location ? ` in ${location}` : ""}`
    : item.title;

  const highlights = [];
  if (d.sqft) highlights.push(`${Number(d.sqft).toLocaleString()} sq ft`);
  if (d.features) highlights.push(...extractList(d.features));
  if (d.yearBuilt) highlights.push(`Built in ${d.yearBuilt}`);
  if (d.lotSize) highlights.push(`${d.lotSize} lot`);
  if (d.garage) highlights.push(`${d.garage}-car garage`);
  if (highlights.length === 0 && d.description) {
    highlights.push(...extractHighlights(d.description, 3));
  }

  return {
    headline,
    highlights: highlights.slice(0, 5),
    emotionalHook: d.description
      ? extractHook(d.description)
      : "Your next chapter starts here",
    pricePoint: formatPrice(d.price),
    location: location || undefined,
  };
}

function transformCarSales(item) {
  const d = item.dataJson;
  const year = d.year || "";
  const make = d.make || "";
  const model = d.model || "";
  const headline = [year, make, model].filter(Boolean).join(" ") || item.title;

  const highlights = [];
  if (d.mileage) highlights.push(`${Number(d.mileage).toLocaleString()} miles`);
  if (d.transmission) highlights.push(d.transmission);
  if (d.drivetrain) highlights.push(d.drivetrain);
  if (d.fuelType || d.fuel) highlights.push(d.fuelType || d.fuel);
  if (d.color || d.exteriorColor) highlights.push(d.color || d.exteriorColor);
  if (d.features) highlights.push(...extractList(d.features));

  return {
    headline: `${headline} — Available Now`,
    highlights: highlights.slice(0, 5),
    urgency: "Limited availability — schedule a test drive",
    pricePoint: formatPrice(d.price),
  };
}

function transformLegal(item) {
  const d = item.dataJson;

  const authorityTopics = [];
  if (d.specialties) authorityTopics.push(...extractList(d.specialties));
  if (d.services) authorityTopics.push(...extractList(d.services));
  if (d.practiceAreas) authorityTopics.push(...extractList(d.practiceAreas));

  const trustSignals = [];
  if (d.experience) trustSignals.push(d.experience);
  if (d.yearsExperience) trustSignals.push(`${d.yearsExperience}+ years experience`);
  if (d.location) trustSignals.push(`Serving ${d.location}`);
  if (d.barAdmissions) trustSignals.push(d.barAdmissions);
  if (d.awards) trustSignals.push(...extractList(d.awards));

  return {
    headline: item.title,
    highlights: authorityTopics.slice(0, 5),
    authorityTopics: authorityTopics.slice(0, 5),
    trustSignals: trustSignals.slice(0, 4),
  };
}

function transformFinancialServices(item) {
  const d = item.dataJson;

  const highlights = [];
  if (d.services) highlights.push(...extractList(d.services));
  if (d.rates) highlights.push(`Rates from ${d.rates}`);
  if (d.coverage) highlights.push(d.coverage);
  if (d.benefits) highlights.push(...extractList(d.benefits));

  const trustSignals = [];
  if (d.licenses) trustSignals.push(d.licenses);
  if (d.certifications) trustSignals.push(...extractList(d.certifications));
  if (d.experience) trustSignals.push(d.experience);

  return {
    headline: item.title,
    highlights: highlights.slice(0, 5),
    trustSignals: trustSignals.slice(0, 4),
    emotionalHook: d.description ? extractHook(d.description) : undefined,
  };
}

function transformRestaurant(item) {
  const d = item.dataJson;

  const highlights = [];
  if (d.cuisine) highlights.push(d.cuisine);
  if (d.price || d.priceRange) highlights.push(d.price || d.priceRange);
  if (d.ingredients) highlights.push(...extractList(d.ingredients));
  if (d.dietaryInfo) highlights.push(d.dietaryInfo);
  if (d.features) highlights.push(...extractList(d.features));

  return {
    headline: item.title,
    highlights: highlights.slice(0, 5),
    emotionalHook: d.description ? extractHook(d.description) : undefined,
    pricePoint: formatPrice(d.price),
  };
}

function transformFitness(item) {
  const d = item.dataJson;

  const highlights = [];
  if (d.duration) highlights.push(d.duration);
  if (d.level || d.difficulty) highlights.push(d.level || d.difficulty);
  if (d.equipment) highlights.push(`Equipment: ${d.equipment}`);
  if (d.benefits) highlights.push(...extractList(d.benefits));
  if (d.schedule) highlights.push(d.schedule);

  return {
    headline: item.title,
    highlights: highlights.slice(0, 5),
    emotionalHook: d.description
      ? extractHook(d.description)
      : "Transform your routine",
  };
}

function transformEcommerce(item) {
  const d = item.dataJson;

  const highlights = [];
  if (d.features) highlights.push(...extractList(d.features));
  if (d.material) highlights.push(d.material);
  if (d.dimensions || d.size) highlights.push(d.dimensions || d.size);
  if (d.shipping) highlights.push(d.shipping);
  if (d.rating) highlights.push(`${d.rating} stars`);
  if (d.reviews) highlights.push(`${d.reviews} reviews`);

  return {
    headline: item.title,
    highlights: highlights.slice(0, 5),
    pricePoint: formatPrice(d.price),
    urgency: d.stock && Number(d.stock) < 10 ? "Limited stock remaining" : undefined,
  };
}

function transformDefault(item) {
  if (!item) return null;

  const d = item?.dataJson ?? {};
  const highlights = [];

  // Pull whatever meaningful values exist
  for (const [k, v] of Object.entries(d)) {
    if (!v || k === "imageUrl") continue;
    if (typeof v === "string" && v.length > 5 && v.length < 100) {
      highlights.push(v);
    }
  }

  return {
    headline: item.title || "Business highlight",
    highlights: highlights.slice(0, 5),
    emotionalHook: item.summary || undefined,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatPrice(value) {
  if (!value) return undefined;
  const num = typeof value === "string" ? parseFloat(value.replace(/[^0-9.]/g, "")) : value;
  if (isNaN(num)) return String(value);
  return `$${num.toLocaleString()}`;
}

function extractList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function extractHighlights(text, max = 3) {
  // Pull short, punchy phrases from a description
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 10 && s.length < 80);
  return sentences.slice(0, max);
}

function extractHook(text) {
  // First sentence as emotional hook, capped at 80 chars
  const first = text.split(/[.!?]/)[0]?.trim();
  if (!first || first.length < 5) return undefined;
  return first.length > 80 ? first.slice(0, 77) + "..." : first;
}
