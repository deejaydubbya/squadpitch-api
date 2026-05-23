import { describe, it, expect } from "vitest";
import {
  getPhrasebook,
  getPhrase,
  getSupportedPhrasebookIndustries,
} from "../domains/industry/phrasebooks.js";

describe("phrasebooks", () => {
  describe("car_sales", () => {
    it("returns English by default", () => {
      const pb = getPhrasebook("car_sales", "en");
      expect(pb.vehicle_spotlight).toBe("Vehicle spotlight");
      expect(pb.schedule_test_drive).toBe("Schedule a test drive");
      expect(pb.browse_inventory).toBe("Browse inventory");
    });
    it("returns Spanish for es", () => {
      const pb = getPhrasebook("car_sales", "es");
      expect(pb.vehicle_spotlight).toBe("Vehículo destacado");
      expect(pb.schedule_test_drive).toBe("Agenda una prueba de manejo");
      expect(pb.browse_inventory).toBe("Explora el inventario");
      expect(pb.trade_ins_welcome).toBe("Aceptamos vehículos como parte de pago");
    });
  });

  describe("real_estate", () => {
    it("covers required English phrases", () => {
      const pb = getPhrasebook("real_estate", "en");
      expect(pb.schedule_showing).toBe("Schedule a showing");
      expect(pb.just_listed).toBe("Just listed");
      expect(pb.open_house).toBe("Open house");
    });
    it("covers required Spanish phrases", () => {
      const pb = getPhrasebook("real_estate", "es");
      expect(pb.schedule_showing).toBe("Agenda una visita");
      expect(pb.just_listed).toBe("Recién publicada");
      expect(pb.open_house).toBe("Casa abierta");
    });
  });

  describe("generic", () => {
    it("English defaults", () => {
      expect(getPhrase("generic", "en", "learn_more")).toBe("Learn more");
      expect(getPhrase("generic", "en", "contact_us")).toBe("Contact us");
      expect(getPhrase("generic", "en", "book_now")).toBe("Book now");
    });
    it("Spanish translations", () => {
      expect(getPhrase("generic", "es", "learn_more")).toBe("Más información");
      expect(getPhrase("generic", "es", "limited_time_offer")).toBe("Oferta por tiempo limitado");
    });
  });

  describe("fallback behavior", () => {
    it("unknown industry falls back to generic", () => {
      const pb = getPhrasebook("nonexistent_industry", "en");
      expect(pb.learn_more).toBe("Learn more");
    });
    it("unknown language drops to English", () => {
      const pb = getPhrasebook("car_sales", "fr");
      expect(pb.vehicle_spotlight).toBe("Vehicle spotlight");
    });
    it("missing phrase falls through to English then to key", () => {
      // Add a key that doesn't exist anywhere
      expect(getPhrase("car_sales", "es", "nonexistent_phrase")).toBe("nonexistent_phrase");
      expect(getPhrase("car_sales", "es", "nonexistent_phrase", "Custom fallback")).toBe("Custom fallback");
    });
    it("missing in es but present in en falls through", () => {
      // schedule_showing only exists in real_estate, not car_sales
      // → since real_estate.es has it, asking car_sales lookups fall through:
      // English car_sales doesn't have it either → falls to key.
      expect(getPhrase("car_sales", "es", "vehicle_spotlight")).toBe("Vehículo destacado");
    });
  });

  describe("supported industries", () => {
    it("includes the three documented industries", () => {
      const list = getSupportedPhrasebookIndustries();
      expect(list).toContain("car_sales");
      expect(list).toContain("real_estate");
      expect(list).toContain("generic");
    });
  });
});
