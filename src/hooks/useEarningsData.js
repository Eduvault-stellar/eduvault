import { useEffect, useState } from 'react';

/**
 * Generate mock data points for the requested interval.
 */
const generateMock = (interval) => {
  const points = [];
  const now = new Date();
  const days = interval === '7d' ? 7 : interval === '30d' ? 30 : 365; // YTD approximated as 365 days
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(now.getDate() - i);
    // Mock values – you can replace with realistic distribution.
    const earnings = Math.round(500 + Math.random() * 1500);
    const gas = Math.round(50 + Math.random() * 200);
    const royalties = Math.round(200 + Math.random() * 800);
    points.push({
      date: date.toISOString().split('T')[0], // YYYY-MM-DD
      earnings,
      gas,
      royalties,
      net: earnings - gas - royalties,
    });
  }
  return points;
};

/**
 * useEarningsData – mock hook that returns earnings data for the selected interval.
 * In a real implementation this would fetch from the backend.
 */
export default function useEarningsData(interval) {
  const [data, setData] = useState([]);

  useEffect(() => {
    const mock = generateMock(interval);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(mock);
  }, [interval]);

  return data;
}
