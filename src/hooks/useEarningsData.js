import { useEffect, useState } from "react";

const INTERVAL_DAYS = Object.freeze({ "7d": 7, "30d": 30, ytd: 365 });

export default function useEarningsData(interval) {
  const [data, setData] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    const days = INTERVAL_DAYS[interval] || INTERVAL_DAYS["30d"];
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - (days - 1));

    async function load() {
      const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
      const response = await fetch(`/api/creator/analytics?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Creator analytics request failed (${response.status})`);
      const result = await response.json();
      setData(
        (result.chartData || []).map((point) => ({
          date: point.date,
          earnings: Number(point.revenue || 0),
          gas: 0,
          royalties: 0,
          net: Number(point.revenue || 0),
          assetKey: result.assetKey,
        })),
      );
    }

    load().catch((error) => {
      if (error.name !== "AbortError") setData([]);
    });
    return () => controller.abort();
  }, [interval]);

  return data;
}
