/**
 * ResourceStatusBadge — derives and renders status badges for a material.
 *
 * Badge meanings:
 *   Free        — price is 0 or absent
 *   New         — no feedback/ratings recorded yet
 *   Verified    — creator-verified content (material.verified === true)
 *   Top Rated   — averageScore >= 4.5
 *   Popular     — likes >= 1000
 *   Draft       — visibility is "private"
 *   Unlisted    — visibility is "unlisted"
 *   Published   — visibility is "public"
 *
 * See docs/resource-status-badges.md for full reference.
 */

const BADGE_STYLES = {
  Free: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  New: "bg-blue-50 text-blue-700 border border-blue-200",
  Verified: "bg-indigo-50 text-indigo-700 border border-indigo-200",
  "Top Rated": "bg-amber-50 text-amber-700 border border-amber-200",
  Popular: "bg-purple-50 text-purple-700 border border-purple-200",
  Draft: "bg-gray-100 text-gray-600 border border-gray-200",
  Unlisted: "bg-orange-50 text-orange-700 border border-orange-200",
  Published: "bg-green-50 text-green-700 border border-green-200",
};

export function deriveBadges(material) {
  if (!material) return [];

  const badges = [];
  const price = Number(material.price ?? 0);
  const score = Number(material.averageScore ?? material.rating ?? 0);
  const feedbackCount = Number(material.feedbackCount ?? material.reviewsCount ?? 0);
  const likes = Number(material.likes ?? 0);
  const visibility = material.visibility;

  if (!Number.isFinite(price) || price === 0) {
    badges.push("Free");
  }

  if (feedbackCount === 0 || !Number.isFinite(score) || score === 0) {
    badges.push("New");
  } else if (score >= 4.5) {
    badges.push("Top Rated");
  }

  if (material.verified) {
    badges.push("Verified");
  }

  if (likes >= 1000) {
    badges.push("Popular");
  }

  if (visibility === "private") {
    badges.push("Draft");
  } else if (visibility === "unlisted") {
    badges.push("Unlisted");
  } else if (visibility === "public") {
    badges.push("Published");
  }

  return badges;
}

/**
 * Renders a single badge pill.
 */
export function StatusBadge({ label, className = "" }) {
  const base = BADGE_STYLES[label] ?? "bg-gray-100 text-gray-600 border border-gray-200";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold leading-tight ${base} ${className}`}
      aria-label={`Status: ${label}`}
    >
      {label}
    </span>
  );
}

/**
 * Renders a row of status badges derived from a material object.
 *
 * @param {object} material - material data object
 * @param {number} [max]    - max badges to show (default: all)
 * @param {string} [className]
 */
export default function ResourceStatusBadge({ material, max, className = "" }) {
  const badges = deriveBadges(material);
  const visible = max ? badges.slice(0, max) : badges;

  if (visible.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-1 ${className}`} role="list" aria-label="Resource status badges">
      {visible.map((label) => (
        <span key={label} role="listitem">
          <StatusBadge label={label} />
        </span>
      ))}
    </div>
  );
}
