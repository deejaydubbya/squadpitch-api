export default {
  key: "car_sales",
  label: "Car Sales",
  description: "Auto dealerships, independent car lots, and vehicle sales professionals.",
  onboarding: {
    websitePlaceholder: "citymotors.com",
    extraContextLabel: "Inventory or dealership details",
    extraContextPlaceholder: "Describe your inventory focus, brands carried, or paste vehicle details...",
    helperText: "We'll extract your inventory, promotions, and dealership highlights.",
  },
  extraction: {
    hints: "Focus on vehicle inventory (make, model, year, price, mileage), financing offers, trade-in deals, customer reviews, and dealership events or sales.",
    priorityDataTypes: ["CUSTOM", "PROMOTION", "TESTIMONIAL", "EVENT"],
  },
  content: {
    starterBlueprintSlugs: ["new-arrival", "deal-spotlight", "customer-delivery"],
    starterChannels: ["INSTAGRAM", "FACEBOOK", "TIKTOK"],
    starterAngles: [
      "Showcase a new arrival on the lot — highlight key specs, price, and what makes it a great deal.",
      "Create a limited-time financing or trade-in promotion post with urgency.",
      "Share a happy customer delivery photo moment — celebrate the purchase.",
    ],
  },
  integrations: {
    supportedCapabilities: ["inventory_feed", "crm"],
    recommendedProviders: ["dealer_com", "vauto"],
    starterAutomations: ["new_inventory_post", "price_drop_alert"],
  },
  ui: { icon: "Car" },
};
