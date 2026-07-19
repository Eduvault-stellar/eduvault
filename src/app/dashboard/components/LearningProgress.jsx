"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FiBook, FiCheckCircle } from "react-icons/fi";

export default function LearningProgress() {
  const [progress, setProgress] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function fetchProgress() {
      try {
        const response = await fetch("/api/progress", {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("Unable to fetch learning progress.");
        }

        const data = await response.json();

        if (!controller.signal.aborted) {
          setProgress(Array.isArray(data) ? data : []);
        }
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Failed to fetch progress:", error);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    fetchProgress();

    return () => {
      controller.abort();
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-4 h-6 w-1/3 animate-pulse rounded bg-gray-200 dark:bg-gray-800" />

        <div className="space-y-3">
          {[1, 2].map((item) => (
            <div
              key={item}
              className="h-12 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <h2 className="mb-4 flex items-center text-xl font-bold">
        <FiCheckCircle className="mr-2 text-green-500" />
        My Learning Progress
      </h2>

      {progress.length === 0 ? (
        <div className="py-6 text-center">
          <FiBook className="mx-auto mb-2 h-10 w-10 text-gray-300" />

          <p className="text-sm text-gray-500">
            You haven&apos;t completed any resources yet.
          </p>

          <Link
            href="/marketplace"
            className="mt-2 inline-block text-sm text-blue-500 hover:underline"
          >
            Explore marketplace
          </Link>
        </div>
      ) : (
        <div>
          <div className="mb-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                Total Completed
              </span>

              <span className="text-lg font-bold">{progress.length}</span>
            </div>

            <div className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className="h-2 rounded-full bg-green-500"
                style={{ width: "100%" }}
              />
            </div>
          </div>

          <div className="mt-4 max-h-60 space-y-3 overflow-y-auto">
            {progress.slice(0, 5).map((item) => (
              <Link
                key={item._id}
                href={`/marketplace/materials/${item.materialId}`}
                className="flex items-center rounded-lg border border-transparent p-3 transition-colors hover:border-gray-200 hover:bg-gray-50 dark:hover:border-gray-700 dark:hover:bg-gray-800"
              >
                <div className="mr-3 rounded-full bg-green-100 p-2 text-green-600 dark:bg-green-900/30 dark:text-green-400">
                  <FiCheckCircle size={16} />
                </div>

                <div className="min-w-0">
                  <div className="max-w-xs truncate text-sm font-medium text-gray-900 dark:text-white">
                    {item.material?.title || "Unknown Resource"}
                  </div>

                  <div className="text-xs text-gray-500">
                    {item.completedAt
                      ? new Date(item.completedAt).toLocaleDateString()
                      : "Completion date unavailable"}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}