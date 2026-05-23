// Phase 1 multilingual support — per-industry phrasebooks for
// hard-coded marketing phrases that bypass the LLM.
//
// Most customer-facing copy goes through promptBuilder → OpenAI,
// which gets the Spanish directive from `languageInstructions.js`
// and writes Spanish output directly. That covers post bodies,
// captions, CTAs the model is asked to invent, landing-page block
// text, and inbox replies.
//
// But there are pockets of *hardcoded* English the LLM never sees:
// lead-form CTA copy, site template hero placeholders, starter
// angle prompts injected verbatim into the UI, default "Schedule
// a showing" button labels, etc. Those need translated strings.
//
// This module is the single source of truth for those translations.
// `getPhrase("car_sales", "es", "vehicle_spotlight")` returns the
// Spanish string; missing translations fall through to English so
// rendering never breaks.
//
// Keep keys in `snake_case` — they're stable IDs the rest of the
// codebase imports, not display text.

import { normalizeLanguage } from "../../lib/languages.js";

const CAR_SALES = {
  en: {
    vehicle_spotlight: "Vehicle spotlight",
    check_availability: "Check availability",
    schedule_test_drive: "Schedule a test drive",
    browse_inventory: "Browse inventory",
    financing_available: "Financing available",
    trade_ins_welcome: "Trade-ins welcome",
    fresh_inventory: "Fresh inventory",
  },
  es: {
    vehicle_spotlight: "Vehículo destacado",
    check_availability: "Consulta la disponibilidad",
    schedule_test_drive: "Agenda una prueba de manejo",
    browse_inventory: "Explora el inventario",
    financing_available: "Financiamiento disponible",
    trade_ins_welcome: "Aceptamos vehículos como parte de pago",
    fresh_inventory: "Inventario nuevo",
  },
};

const REAL_ESTATE = {
  en: {
    schedule_showing: "Schedule a showing",
    view_property_details: "View property details",
    open_house: "Open house",
    contact_agent: "Contact the agent",
    just_listed: "Just listed",
    new_listing: "New listing",
  },
  es: {
    schedule_showing: "Agenda una visita",
    view_property_details: "Ver detalles de la propiedad",
    open_house: "Casa abierta",
    contact_agent: "Contacta al agente",
    just_listed: "Recién publicada",
    new_listing: "Nueva propiedad",
  },
};

const GENERIC = {
  en: {
    learn_more: "Learn more",
    contact_us: "Contact us",
    book_now: "Book now",
    get_a_quote: "Get a quote",
    limited_time_offer: "Limited-time offer",
    new_service: "New service",
  },
  es: {
    learn_more: "Más información",
    contact_us: "Contáctanos",
    book_now: "Reserva ahora",
    get_a_quote: "Solicita una cotización",
    limited_time_offer: "Oferta por tiempo limitado",
    new_service: "Nuevo servicio",
  },
};

const PHRASEBOOKS = {
  car_sales: CAR_SALES,
  real_estate: REAL_ESTATE,
  generic: GENERIC,
};

/**
 * Resolve the phrasebook for an industry + language. Unknown
 * industries fall back to GENERIC; unknown languages drop to
 * English. Returns a flat string→string map.
 *
 * @param {string} industryKey  e.g. "car_sales", "real_estate"
 * @param {string} language     ISO 639-1; normalized internally
 * @returns {Record<string, string>}
 */
export function getPhrasebook(industryKey, language) {
  const industry = PHRASEBOOKS[industryKey] ?? GENERIC;
  const lang = normalizeLanguage(language);
  return industry[lang] ?? industry.en;
}

/**
 * Resolve a single phrase. If the phrase is missing in the chosen
 * language, fall through to English. If still missing, return the
 * `fallback` (or the key itself) so rendering can't break.
 *
 * @param {string} industryKey
 * @param {string} language
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
export function getPhrase(industryKey, language, key, fallback) {
  const book = getPhrasebook(industryKey, language);
  if (book[key]) return book[key];
  // English fallback for partial coverage.
  const enBook = getPhrasebook(industryKey, "en");
  if (enBook[key]) return enBook[key];
  return fallback ?? key;
}

/** Surfaces the set of industries this phrasebook knows about. */
export function getSupportedPhrasebookIndustries() {
  return Object.keys(PHRASEBOOKS);
}
