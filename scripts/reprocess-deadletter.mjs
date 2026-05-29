import { getDb } from "../src/lib/mongodb.js";
import { reprocessDeadLetters } from "../src/lib/indexer/stellarIndexer.js";

const db = await getDb();
const result = await reprocessDeadLetters(db, { statuses: ["retryable", "failed"], limit: 500 });
console.log(JSON.stringify({ event: "deadletter_reprocess_complete", ...result }));
