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
  // Dispatch by item type for type-aware context building
  if (item.type === "TESTIMONIAL") return transformRealEstateTestimonial(item);
  if (item.type === "MILESTONE") return transformRealEstateMilestone(item);

  // Default: listing-shaped data (CUSTOM type)
  const d = item.dataJson;
  const beds = d.bedrooms || d.beds;
  const baths = d.bathrooms || d.baths;
  const city = d.city || d.location || "";
  const state = d.state || "";
  const neighborhood = d.neighborhood || "";
  const locationParts = [neighborhood, city, state].filter(Boolean);
  const location = locationParts.join(", ");

  const address = d.address || d.street || null;

  const headline = beds && baths
    ? `${beds} Bed / ${baths} Bath Home${location ? ` in ${location}` : ""}`
    : address && location
      ? `${address}, ${location}`
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

  // Trust signals from listing data
  const trustSignals = [];
  if (d.daysOnMarket != null) trustSignals.push(`${d.daysOnMarket} days on market`);
  if (d.agent || d.listedBy) trustSignals.push(`Listed by ${d.agent || d.listedBy}`);
  if (d.broker || d.brokerage) trustSignals.push(d.broker || d.brokerage);

  return {
    headline,
    highlights: highlights.slice(0, 5),
    emotionalHook: d.description
      ? extractHook(d.description)
      : undefined,
    pricePoint: formatPrice(d.price),
    location: location || undefined,
    ...(trustSignals.length > 0 && { trustSignals }),
  };
}

function transformRealEstateTestimonial(item) {
  const d = item.dataJson ?? {};

  const author = d.author || d.name || d.client || null;
  const quote = d.quote || d.testimonial || d.review || item.summary || null;
  const rating = d.rating || d.stars || null;

  const headline = author
    ? `Client Testimonial from ${author}`
    : item.title || "Client Testimonial";

  const trustSignals = [];
  if (quote) trustSignals.push(`"${quote.length > 150 ? quote.slice(0, 147) + "..." : quote}"`);
  if (author) trustSignals.push(`— ${author}${d.role ? `, ${d.role}` : ""}`);
  if (rating) trustSignals.push(`${rating}/5 stars`);
  if (d.result || d.outcome) trustSignals.push(d.result || d.outcome);

  const highlights = [];
  if (d.context) highlights.push(d.context);
  if (d._sourceType === "gbp") highlights.push("Google Business Profile review");
  if (d._sourceType === "crm") highlights.push("CRM client feedback");

  return {
    headline,
    highlights,
    trustSignals: trustSignals.slice(0, 4),
    emotionalHook: quote
      ? extractHook(quote)
      : "Happy client experience",
  };
}

function transformRealEstateMilestone(item) {
  const d = item.dataJson ?? {};

  const achievement = d.achievement || "Milestone";
  const address = d.address || null;
  const price = d.price || null;
  const closingDate = d.closingDate || null;
  const clientName = d.clientName || d.personName || null;

  const headline = address
    ? `${achievement}: ${address}`
    : `${achievement}${clientName ? ` with ${clientName}` : ""}`;

  const highlights = [];
  if (address) highlights.push(address);
  if (price) highlights.push(`$${Number(price).toLocaleString()}`);
  if (closingDate) highlights.push(`Closed ${closingDate}`);
  if (d.dealType && d.dealType !== "Sale") highlights.push(d.dealType);

  const trustSignals = [];
  trustSignals.push(achievement);
  if (clientName) trustSignals.push(`Client: ${clientName}`);
  if (d.description || d.significance) trustSignals.push(d.description || d.significance);

  return {
    headline,
    highlights: highlights.slice(0, 5),
    pricePoint: formatPrice(price),
    trustSignals: trustSignals.slice(0, 4),
    emotionalHook: address
      ? `Another successful closing at ${address}`
      : "Another milestone achieved",
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
