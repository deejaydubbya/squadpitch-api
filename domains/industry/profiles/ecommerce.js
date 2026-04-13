export default {
  key: "ecommerce",
  label: "E-Commerce / Online Store",
  description: "Online stores, DTC brands, and digital retailers.",
  onboarding: {
    websitePlaceholder: "mybrand.shop",
    extraContextLabel: "Product or brand details",
    extraContextPlaceholder: "Describe your best-selling products, brand story, or target audience...",
    helperText: "We'll extract your products, reviews, and brand identity.",
  },
  extraction: {
    hints: "Focus on product listings (name, price, description, category), customer reviews, brand story, shipping/return policies, bestsellers, and promotional offers.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "PROMOTION", "PRODUCT_LAUNCH"],
  },
  content: {
    starterBlueprintSlugs: ["product-spotlight", "customer-review", "behind-the-brand"],
    starterChannels: ["INSTAGRAM", "TIKTOK", "FACEBOOK"],
    starterAngles: [
      "Spotlight a best-selling product — highlight what makes it unique and why customers love it.",
      "Turn a real customer review into a social proof post with the product front and center.",
      "Share a behind-the-scenes look at how products are made, packed, or shipped.",
    ],
  },
  integrations: {
    supportedCapabilities: ["product_feed", "reviews"],
    recommendedProviders: ["shopify", "woocommerce"],
    starterAutomations: ["new_product_post", "sale_announcement"],
  },
  ui: { icon: "ShoppingBag" },
};
