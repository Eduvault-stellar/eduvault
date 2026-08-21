const INDEX_NAME = "saved_materials_wallet_material_unique";
const MAX_DEDUPLICATION_PASSES = 3;
const SAVED_MATERIALS = "saved_materials";
const MIGRATION_CONFLICTS = "_migration_conflicts";

function isDuplicateKey(error) {
  return error?.code === 11000 || error?.codeName === "DuplicateKey";
}

async function archiveAndDeleteDuplicates({ db, logger }) {
  const savedMaterials = db.collection(SAVED_MATERIALS);
  const conflicts = db.collection(MIGRATION_CONFLICTS);
  const groups = savedMaterials.aggregate([
    {
      $match: {
        walletAddress: { $type: "string" },
        materialId: { $type: "string" },
      },
    },
    {
      $group: {
        _id: { walletAddress: "$walletAddress", materialId: "$materialId" },
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  let archived = 0;
  let deleted = 0;

  for await (const group of groups) {
    const documents = await savedMaterials
      .find({ _id: { $in: group.ids } })
      .sort({ savedAt: 1, _id: 1 })
      .toArray();
    const canonical = documents[0];

    for (const duplicate of documents.slice(1)) {
      await conflicts.updateOne(
        {
          migrationVersion: 5,
          sourceCollection: SAVED_MATERIALS,
          sourceId: duplicate._id,
          indexName: INDEX_NAME,
        },
        {
          $setOnInsert: {
            migrationVersion: 5,
            sourceCollection: SAVED_MATERIALS,
            sourceId: duplicate._id,
            indexName: INDEX_NAME,
            duplicateKey: group._id,
            canonicalSourceId: canonical._id,
            archivedDocument: duplicate,
            archivedAt: new Date(),
            reason: "duplicate-wallet-material-bookmark",
          },
        },
        { upsert: true },
      );
      archived += 1;

      const result = await savedMaterials.deleteOne({ _id: duplicate._id });
      deleted += result.deletedCount;
    }
  }

  logger.info?.("[migration:005] Bookmark duplicates resolved", {
    archived,
    deleted,
  });
}

const migration = {
  version: 5,
  name: "saved-material-uniqueness",
  description:
    "Archives duplicate wallet-material bookmarks and installs the unique index in databases that already ran the original index migration.",

  async up({ db, logger = console }) {
    for (let pass = 1; pass <= MAX_DEDUPLICATION_PASSES; pass += 1) {
      await archiveAndDeleteDuplicates({ db, logger });

      try {
        await db.collection(SAVED_MATERIALS).createIndex(
          { walletAddress: 1, materialId: 1 },
          { name: INDEX_NAME, unique: true },
        );
        logger.info?.("[migration:005] Bookmark uniqueness index ensured", {
          indexName: INDEX_NAME,
          pass,
        });
        return;
      } catch (error) {
        if (!isDuplicateKey(error) || pass === MAX_DEDUPLICATION_PASSES) {
          throw error;
        }

        logger.warn?.("[migration:005] Concurrent duplicate detected; retrying", {
          pass,
        });
      }
    }
  },

  async down({ db, logger = console }) {
    try {
      await db.collection(SAVED_MATERIALS).dropIndex(INDEX_NAME);
    } catch (error) {
      if (error?.code !== 27 && error?.codeName !== "IndexNotFound") throw error;
    }

    logger.info?.("[migration:005] Bookmark uniqueness index removed");
  },
};

export default migration;
