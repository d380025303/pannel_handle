// Load only the requested capability: shared parsers/clients do not load service orchestration.
module.exports = {
  get createWorkBuddyCheckinService() {
    return require("./workbuddy-checkin-service.cjs").createWorkBuddyCheckinService;
  },
  get createWorkBuddyAutoCheckinService() {
    return require("./workbuddy-auto-checkin-service.cjs").createWorkBuddyAutoCheckinService;
  },
  get createWorkBuddyModelCatalogService() {
    return require("./workbuddy-model-catalog-service.cjs").createWorkBuddyModelCatalogService;
  },
  get getPromotionDisplay() {
    return require("./model-catalog-values.cjs").getPromotionDisplay;
  },
  get normalizeCatalogData() {
    return require("./model-catalog-values.cjs").normalizeCatalogData;
  },
  get runCodeBuddyUserInfoRequest() {
    return require("./codebuddy-user-info-client.cjs").runCodeBuddyUserInfoRequest;
  }
};
