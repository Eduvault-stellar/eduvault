"use client";

import { useState } from "react";
import { FaShareAlt, FaCheck } from "react-icons/fa";

export default function ShareMaterialButton({ material, className = "" }) {
  const [copied, setCopied] = useState(false);

  const handleShare = async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    const shareText = `Check out "${material.title}" on EduVault!\n${url}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: material.title,
          text: `Check out "${material.title}" on EduVault!`,
          url: url,
        });
      } else {
        await navigator.clipboard.writeText(shareText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }

      console.log("[Analytics] Tracked Share Interaction for material:", material._id || material.id);
      try {
        await fetch('/api/analytics/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'share_material', materialId: material._id || material.id })
        });
      } catch (e) {
        // silently ignore tracking errors
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error("Failed to share", err);
      }
    }
  };

  return (
    <button
      type="button"
      onClick={handleShare}
      className={`flex items-center justify-center gap-2 border border-gray-300 text-gray-700 font-semibold rounded-md hover:bg-gray-100 transition focus-visible:ring-2 focus-visible:ring-blue-500 ${className}`}
      title="Share this material"
    >
      {copied ? <FaCheck className="text-green-600" /> : <FaShareAlt />}
      {copied ? "Shared!" : "Share"}
    </button>
  );
}
