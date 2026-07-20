"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  FiActivity as Activity,
  FiArrowUpRight as ArrowUpRight,
  FiBarChart2 as BarChart,
  FiBookOpen as BookOpen,
  FiCheckCircle as CheckCircle,
  FiShoppingBag as ShoppingBag,
  FiUpload as Upload,
  FiUsers as Users,
} from "react-icons/fi";

const EMPTY_CHART = [
  { day: "Mon", revenue: 0, orders: 0, uploads: 0, interest: 0 },
  { day: "Tue", revenue: 0, orders: 0, uploads: 0, interest: 0 },
  { day: "Wed", revenue: 0, orders: 0, uploads: 0, interest: 0 },
  { day: "Thu", revenue: 0, orders: 0, uploads: 0, interest: 0 },
  { day: "Fri", revenue: 0, orders: 0, uploads: 0, interest: 0 },
  { day: "Sat", revenue: 0, orders: 0, uploads: 0, interest: 0 },
  { day: "Sun", revenue: 0, orders: 0, uploads: 0, interest: 0 },
];

function formatCurrency(value) {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

function formatAddress(address) {
  if (!address || address === "Unknown buyer") return "Unknown buyer";
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function Skeleton({ className }) {
  return <div className={`animate-pulse rounded-lg bg-gray-100 ${className}`} />;
}

function StatCard({ title, value, sub, icon: Icon, color }) {
  return (
    <div className="flex min-h-32 items-start gap-4 rounded-2xl border border-gray-100 bg-white p-5 shadow-sm">
      <div className={`rounded-xl p-3 ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-gray-500">{title}</p>
        <p className="mt-2 text-2xl font-bold text-gray-950">{value}</p>
        {sub && (
          <p className="mt-2 flex items-center gap-1 text-xs font-medium text-emerald-600">
            <ArrowUpRight size={12} />
            {sub}
          </p>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white p-8 text-center shadow-sm">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50 text-blue-600">
        <BarChart size={24} />
      </div>
      <h2 className="text-lg font-semibold text-gray-900">No educator activity yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
        Upload a material and learner activity will appear here as saves, access requests, and completed orders come in.
      </p>
      <Link
        href="/dashboard/upload"
        className="mt-5 inline-flex items-center justify-center gap-2 rounded-full bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
      >
        <Upload size={16} />
        Upload Material
      </Link>
    </div>
  );
}

function ActivityChart({ data }) {
  const W = 800;
  const H = 240;
  const PAD = { top: 18, right: 28, bottom: 42, left: 42 };
  const rows = data.length ? data : EMPTY_CHART;
  const maxMetric = Math.max(
    ...rows.flatMap((d) => [Number(d.revenue ?? 0), Number(d.orders ?? 0), Number(d.interest ?? 0), Number(d.uploads ?? 0)]),
    1
  );
  const xStep = (W - PAD.left - PAD.right) / Math.max(rows.length - 1, 1);
  const yScale = (value) =>
    PAD.top + (H - PAD.top - PAD.bottom) * (1 - Number(value ?? 0) / maxMetric);

  const points = rows.map((row, index) => ({
    x: PAD.left + index * xStep,
    y: yScale(row.revenue),
  }));

  const pathD = points.reduce((acc, point, index) => {
    if (index === 0) return `M ${point.x},${point.y}`;
    const previous = points[index - 1];
    const cpX = (previous.x + point.x) / 2;
    return `${acc} C ${cpX},${previous.y} ${cpX},${point.y} ${point.x},${point.y}`;
  }, "");

  const areaD = `${pathD} L ${points[points.length - 1].x},${H - PAD.bottom} L ${points[0].x},${H - PAD.bottom} Z`;
  const barWidth = Math.min(18, xStep / 5);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="educatorRevenueGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((tick) => {
          const y = PAD.top + (H - PAD.top - PAD.bottom) * tick;
          return (
            <line
              key={tick}
              x1={PAD.left}
              y1={y}
              x2={W - PAD.right}
              y2={y}
              stroke="#e5e7eb"
              strokeWidth="1"
            />
          );
        })}
        {rows.map((row, index) => {
          const x = PAD.left + index * xStep;
          const orderHeight = H - PAD.bottom - yScale(row.orders);
          const interestHeight = H - PAD.bottom - yScale(row.interest);
          return (
            <g key={`${row.day}-${index}`}>
              <rect
                x={x - barWidth - 2}
                y={H - PAD.bottom - orderHeight}
                width={barWidth}
                height={Math.max(orderHeight, row.orders ? 2 : 0)}
                rx="4"
                fill="#10b981"
              />
              <rect
                x={x + 2}
                y={H - PAD.bottom - interestHeight}
                width={barWidth}
                height={Math.max(interestHeight, row.interest ? 2 : 0)}
                rx="4"
                fill="#f59e0b"
              />
            </g>
          );
        })}
        <path d={areaD} fill="url(#educatorRevenueGradient)" />
        <path d={pathD} fill="none" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((point, index) => (
          <circle key={index} cx={point.x} cy={point.y} r="4" fill="#2563eb" />
        ))}
        {rows.map((row, index) => (
          <text
            key={index}
            x={PAD.left + index * xStep}
            y={H - PAD.bottom + 24}
            textAnchor="middle"
            fontSize="12"
            fill="#6b7280"
          >
            {row.day}
          </text>
        ))}
      </svg>
      <div className="mt-3 flex flex-wrap gap-4 text-xs font-medium text-gray-500">
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-blue-600" />Revenue</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />Orders</span>
        <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-amber-500" />Learner interest</span>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function fetchAnalytics() {
      try {
        const res = await fetch("/api/creator/analytics");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        setData(await res.json());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }

    fetchAnalytics();
  }, []);

  const chartData = data?.chartData?.length ? data.chartData : EMPTY_CHART;
  const topMaterials = data?.topMaterials ?? [];
  const recentOrders = data?.recentOrders ?? [];
  const hasActivity = Boolean(data?.hasActivity);

  const cards = useMemo(
    () => [
      {
        title: "Uploads",
        value: String(data?.uploadCount ?? 0),
        sub: `${data?.publishedCount ?? 0} visible, ${data?.draftCount ?? 0} private`,
        icon: BookOpen,
        color: "bg-blue-600",
      },
      {
        title: "Material Activity",
        value: String(data?.materialActivity ?? 0),
        sub: "Views, downloads, and reviews",
        icon: Activity,
        color: "bg-slate-700",
      },
      {
        title: "Learner Interest",
        value: String(data?.learnerInterest ?? 0),
        sub: `${data?.savedCount ?? 0} saves, ${data?.pendingCount ?? 0} pending`,
        icon: Users,
        color: "bg-amber-500",
      },
      {
        title: "Completed Orders",
        value: String(data?.completedOrders ?? 0),
        sub: `${formatCurrency(data?.totalRevenue)} confirmed revenue`,
        icon: CheckCircle,
        color: "bg-emerald-600",
      },
    ],
    [data]
  );

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-950">Educator Performance</h1>
          <p className="mt-1 text-sm text-gray-500">
            Track uploads, learner interest, material activity, and completed orders.
          </p>
        </div>
        <Link
          href="/dashboard/upload"
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 sm:w-auto"
        >
          <Upload size={16} />
          Upload
        </Link>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {loading
          ? Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-32" />)
          : cards.map((card) => <StatCard key={card.title} {...card} />)}
      </div>

      {!loading && !error && !hasActivity && <EmptyState />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Performance Trend</h2>
              <p className="text-sm text-gray-500">Revenue, orders, and learner saves from the last 7 days.</p>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
              <BarChart size={14} />
              7 days
            </span>
          </div>
          {loading ? <Skeleton className="h-64 w-full" /> : <ActivityChart data={chartData} />}
        </section>

        <section className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-gray-900">Order Health</h2>
          <div className="mt-5 space-y-4">
            {loading ? (
              <>
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </>
            ) : (
              <>
                <div className="rounded-xl bg-emerald-50 p-4">
                  <p className="text-sm font-medium text-emerald-700">Completed</p>
                  <p className="mt-2 text-3xl font-bold text-emerald-900">{data?.completedOrders ?? 0}</p>
                </div>
                <div className="rounded-xl bg-amber-50 p-4">
                  <p className="text-sm font-medium text-amber-700">Pending or indexing</p>
                  <p className="mt-2 text-3xl font-bold text-amber-900">
                    {(data?.pendingCount ?? 0) + (data?.indexingCount ?? 0)}
                  </p>
                </div>
                <div className="rounded-xl bg-blue-50 p-4">
                  <p className="text-sm font-medium text-blue-700">Revenue</p>
                  <p className="mt-2 text-3xl font-bold text-blue-900">{formatCurrency(data?.totalRevenue)}</p>
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div className="border-b border-gray-100 p-5 sm:p-6">
            <h2 className="text-base font-semibold text-gray-900">Material Performance</h2>
          </div>
          {loading ? (
            <div className="space-y-3 p-5 sm:p-6">
              {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}
            </div>
          ) : topMaterials.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-400">No uploaded materials yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-400">
                    <th className="px-5 py-3 font-medium">Material</th>
                    <th className="px-5 py-3 text-right font-medium">Interest</th>
                    <th className="px-5 py-3 text-right font-medium">Orders</th>
                    <th className="px-5 py-3 text-right font-medium">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {topMaterials.map((material) => (
                    <tr key={material.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-5 py-4">
                        <p className="max-w-[260px] truncate font-semibold text-gray-800">{material.name}</p>
                        <p className="mt-1 text-xs capitalize text-gray-400">{material.visibility}</p>
                      </td>
                      <td className="px-5 py-4 text-right text-gray-600">{material.learnerInterest}</td>
                      <td className="px-5 py-4 text-right text-gray-600">{material.completedOrders}</td>
                      <td className="px-5 py-4 text-right font-semibold text-blue-600">{material.revenue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
          <div className="border-b border-gray-100 p-5 sm:p-6">
            <h2 className="text-base font-semibold text-gray-900">Recent Completed Orders</h2>
          </div>
          {loading ? (
            <div className="space-y-3 p-5 sm:p-6">
              {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-10 w-full" />)}
            </div>
          ) : recentOrders.length === 0 ? (
            <div className="p-8 text-center">
              <ShoppingBag className="mx-auto text-gray-300" size={28} />
              <p className="mt-3 text-sm text-gray-400">No completed orders yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-400">
                    <th className="px-5 py-3 font-medium">Material</th>
                    <th className="px-5 py-3 font-medium">Learner</th>
                    <th className="px-5 py-3 text-right font-medium">Amount</th>
                    <th className="px-5 py-3 text-right font-medium">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.map((order) => (
                    <tr key={order.id} className="border-b border-gray-50 last:border-0">
                      <td className="px-5 py-4">
                        <p className="max-w-[240px] truncate font-semibold text-gray-800">{order.material}</p>
                        <p className="mt-1 text-xs capitalize text-emerald-600">{order.status}</p>
                      </td>
                      <td className="px-5 py-4 text-gray-600">{formatAddress(order.buyer)}</td>
                      <td className="px-5 py-4 text-right font-semibold text-gray-800">{order.amount}</td>
                      <td className="px-5 py-4 text-right text-gray-500">{order.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
