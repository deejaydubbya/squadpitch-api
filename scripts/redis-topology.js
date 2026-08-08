import { topologySnapshot } from "../lib/redisTopology.js";

console.log(JSON.stringify(topologySnapshot(), null, 2));
