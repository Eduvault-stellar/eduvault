import { COLLECTIONS } from "../schemaContracts.js";

const INDEX_NAME = "student_verifications_wallet_active_unique";
const MAX_DEDUPLICATION_PASSES = 3;
const STUDENT_VERIFICATIONS = COLLECTIONS.studentVerifications;
const MIGRATION_CONFLICTS = COLLECTIONS.migrationConflicts;

function isDuplicateKey(error) {
  return error?.code === 11000 || error?.codeName === "DuplicateKey";
}

function isIndexConflict(error) {
  // MongoDB raises this when a partial unique index can't be built because
  // pre-existing rows would violate it. Code 11000 is the generic duplicate
  // key error and is the signal we look for both here and in the
  // deduplication retry loop.
  return isDuplicateKey(error);
}

async function archiveAndDeleteActiveDuplicates({ db, logger }) {
  const applications = db.collection(STUDENT_VERIFICATIONS);
  const conflicts = db.collection(MIGRATION_CONFLICTS);

  // #107 acceptance criteria: "The migration detects and reports conflicting
  // production rows before enforcing constraints." We aggregate every wallet
  // that has more than one active (pending|approved) row, archive every
  // duplicate into `_migration_conflicts`, and delete the surplus rows. We
  // keep the *newest* active record as canonical (by submittedAt, then _id)
  // so a user who legitimately resubmitted is not punished for a transient
  // duplicate. Terminal (rejected|expired) rows are left untouched because
  // they don't participate in the partial unique index.
  const groups = applications.aggregate([
    {
      $match: {
        status: { $in: ["pending", "approved"] },
      },
    },
    {
      $group: {
        _id: "$walletAddress",
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  const summary = {
    groupsFound: 0,
    archived: 0,
    deleted: 0,
    conflicts: [],
  };

  for await (const group of groups) {
    summary.groupsFound += 1;

    const documents = await applications
      .find({ _id: { $in: group.ids } })
      .sort({ submittedAt: -1, _id: -1 })
      .toArray();

    if (documents.length <= 1) {
      continue;
    }

    const canonical = documents[0];

    for (const duplicate of documents.slice(1)) {
      const conflictRecord = {
        migrationVersion: 6,
        sourceCollection: STUDENT_VERIFICATIONS,
        sourceId: duplicate._id,
        indexName: INDEX_NAME,
        duplicateKey: { walletAddress: group._id },
        canonicalSourceId: canonical._id,
        archivedDocument: duplicate,
        archivedAt: new Date(),
        reason: "duplicate-active-verification-wallet",
      };

      await conflicts.updateOne(
        {
          migrationVersion: 6,
          sourceCollection: STUDENT_VERIFICATIONS,
          sourceId: duplicate._id,
          indexName: INDEX_NAME,
        },
        { $setOnInsert: conflictRecord },
        { upsert: true },
      );
      summary.conflicts.push({
        walletAddress: group._id,
        duplicateId: String(duplicate._id),
        canonicalId: String(canonical._id),
        duplicateStatus: duplicate.status,
        canonicalStatus: canonical.status,
        archivedAt: conflictRecord.archivedAt,
      });
      summary.archived += 1;

      const result = await applications.deleteOne({ _id: duplicate._id });
      summary.deleted += result.deletedCount;
    }
  }

  if (summary.groupsFound > 0) {
    logger.warn?.(
      "[migration:006] Conflicting active verification rows detected and reconciled",
      {
        groupsFound: summary.groupsFound,
        archived: summary.archived,
        deleted: summary.deleted,
      },
    );
  }

  return summary;
}

const migration = {
  version: 6,
  name: "student-verification-uniqueness",
  description:
    "Detects pre-existing duplicate active (pending|approved) verification applications, archives the duplicates into _migration_conflicts, and enforces a partial unique index on { walletAddress } filtered to active statuses (#107).",

  async up({ db, logger = console }) {
    for (let pass = 1; pass <= MAX_DEDUPLICATION_PASSES; pass += 1) {
      const summary = await archiveAndDeleteActiveDuplicates({
        db,
        logger,
      });

      try {
        await db.collection(STUDENT_VERIFICATIONS).createIndex(
          { walletAddress: 1 },
          {
            name: INDEX_NAME,
            unique: true,
            partialFilterExpression: {
              status: { $in: ["pending", "approved"] },
            },
          },
        );
        logger.info?.(
          "[migration:006] Active-verification uniqueness index ensured",
          {
            indexName: INDEX_NAME,
            pass,
            groupsFound: summary.groupsFound,
            archived: summary.archived,
            deleted: summary.deleted,
          },
        );
        return;
      } catch (error) {
        if (!isIndexConflict(error) || pass === MAX_DEDUPLICATION_PASSES) {
          throw error;
        }
        logger.warn?.(
          "[migration:006] Concurrent duplicate detected; retrying",
          { pass, error: error?.message },
        );
      }
    }
  },

  async down({ db, logger = console }) {
    try {
      await db.collection(STUDENT_VERIFICATIONS).dropIndex(INDEX_NAME);
    } catch (error) {
      if (error?.code !== 27 && error?.codeName !== "IndexNotFound") {
        throw error;
      }
    }
    logger.info?.(
      "[migration:006] Active-verification uniqueness index removed",
    );
  },
};

export default migration;
