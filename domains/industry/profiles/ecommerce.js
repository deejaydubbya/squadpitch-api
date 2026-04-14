export default {
  key: "ecommerce",
  label: "E-Commerce",
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
  recommendationTemplates: [
    { type: "product_launch", tier: "core", title: "Announce a New Product", description: "Build excitement for a new arrival in your store.", priority: "high", guidance: "Create a product launch announcement post. Highlight what's new, key features, pricing, and why customers should be excited.", conditions: { hasData: true } },
    { type: "sale_promotion", tier: "core", title: "Promote a Sale", description: "Drive purchases with a limited-time deal.", priority: "high", guidance: "Create a sale promotion post. Include the discount, eligible products, deadline, and a compelling call-to-action to shop now.", conditions: {} },
    { type: "restocked_alert", tier: "core", title: "Announce a Restock", description: "Drive urgency for a popular item back in stock.", priority: "high", guidance: "Create a restock announcement for a popular product. Emphasize that it sold out before, it's back, and quantities are limited.", conditions: { hasData: true } },
    { type: "customer_review", tier: "secondary", title: "Feature a Customer Review", description: "Showcase social proof from a happy buyer.", priority: "medium", guidance: "Turn a real customer review into a social proof post. Feature the product, the customer's words, and why others should try it.", conditions: { hasData: true } },
    { type: "product_spotlight", tier: "secondary", title: "Spotlight a Product", description: "Deep-dive on a specific product's features and benefits.", priority: "medium", guidance: "Create a detailed product spotlight post. Cover key features, use cases, materials, and what makes it worth buying.", conditions: { hasData: true } },
    { type: "seasonal_collection", tier: "secondary", title: "Promote a Seasonal Collection", description: "Highlight seasonal or trending items.", priority: "medium", guidance: "Create a seasonal collection post. Feature 2-3 products that fit the current season or trend and why they're must-haves.", conditions: {} },
    { type: "behind_the_brand", tier: "advanced", title: "Share Your Brand Story", description: "Humanize your brand with founder or team content.", priority: "low", guidance: "Share the story behind the brand. Why it was started, what drives the team, and what makes the brand different from competitors.", conditions: {} },
  ],
  ui: { icon: "ShoppingBag" },
  techStack: [],
};
