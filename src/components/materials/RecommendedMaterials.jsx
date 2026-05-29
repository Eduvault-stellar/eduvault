"use client";

import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import Link from "next/link";
import Image from "next/image";
import { FaHeart, FaFilePdf } from "react-icons/fa";

function getPreviewImage(material) {
  return material.coverImageUrl || material.thumbnailUrl || material.image || "/images/image1.jpg";
}

export default function RecommendedMaterials({ currentId, subject, category, creator }) {
  const { data, isLoading } = useMarketplaceMaterials({
    subject: subject || undefined,
    category: category || undefined,
    pageSize: 5,
  });

  const recommendations = (data?.items || []).filter(
    (item) => (item._id || item.id) !== currentId
  ).slice(0, 4);

  if (!isLoading && recommendations.length === 0) {
    return null;
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        {subject ? `More in ${subject}` : "Recommended for You"}
      </h2>

      {isLoading ? (
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-xl overflow-hidden animate-pulse">
              <div className="w-full h-32 bg-gray-100" />
              <div className="p-3 space-y-2">
                <div className="h-3 bg-gray-100 rounded w-3/4" />
                <div className="h-2 bg-gray-100 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
          {recommendations.map((material) => {
            const materialId = material._id || material.id;
            return (
              <Link
                key={materialId}
                href={`/marketplace/${materialId}`}
                className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-300 transition-all group block"
              >
                <div className="relative w-full h-32 bg-gray-100 overflow-hidden">
                  <Image
                    src={getPreviewImage(material)}
                    alt={material.title}
                    fill
                    className="object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                </div>
                <div className="p-3">
                  <h3 className="text-sm font-semibold text-gray-900 line-clamp-1 group-hover:text-blue-600 transition-colors">
                    {material.title}
                  </h3>
                  <p className="text-xs text-gray-500 mb-2 truncate">
                    by {material.author || material.creator || "Anonymous"}
                  </p>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1 text-gray-500">
                      <FaHeart className="text-rose-400 w-3 h-3" />
                      {material.likes || 0}
                    </span>
                    <span className="font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                      {material.price} {material.currency || "XLM"}
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
