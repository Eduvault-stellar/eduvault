import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import useEarningsData from '../hooks/useEarningsData';
import './EarningsAnalytics.css';

/**
 * EarningsAnalytics – component that renders interval selectors and an earnings chart.
 * It uses Chart.js loaded from a CDN (no npm install required).
 */
export default function EarningsAnalytics() {
  const intervals = [
    { label: '7 Days', value: '7d' },
    { label: '30 Days', value: '30d' },
    { label: 'Year‑to‑Date', value: 'ytd' },
  ];
  const [selected, setSelected] = useState('7d');
  const data = useEarningsData(selected);

  return (
    <section className="earnings-analytics">
      {/* Load Chart.js from CDN */}
      <Script
        src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
        strategy="lazyOnload"
      />
      <div className="interval-selector" role="radiogroup" aria-label="Time interval">
        {intervals.map(i => (
          <button
            key={i.value}
            className={`interval-btn ${selected === i.value ? 'active' : ''}`}
            onClick={() => setSelected(i.value)}
            aria-pressed={selected === i.value}
          >
            {i.label}
          </button>
        ))}
      </div>
      <Chart data={data} />
    </section>
  );
}

/**
 * Chart – renders a line chart using Chart.js.
 * It waits for the Chart.js script to be available on the window object.
 */
function Chart({ data }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!window.Chart) return; // script not loaded yet
    const ctx = canvasRef.current.getContext('2d');

    // Destroy previous chart instance if exists
    if (chartRef.current) {
      chartRef.current.destroy();
    }

    const labels = data.map(d => d.date);
    const earnings = data.map(d => d.earnings);
    const gas = data.map(d => d.gas);
    const royalties = data.map(d => d.royalties);
    const net = data.map(d => d.net);

    chartRef.current = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Earnings',
            data: earnings,
            borderColor: '#4caf50',
            backgroundColor: 'rgba(76, 175, 80, 0.2)',
            tension: 0.3,
          },
          {
            label: 'Gas Costs',
            data: gas,
            borderColor: '#ff9800',
            backgroundColor: 'rgba(255, 152, 0, 0.2)',
            tension: 0.3,
          },
          {
            label: 'Royalties',
            data: royalties,
            borderColor: '#2196f3',
            backgroundColor: 'rgba(33, 150, 243, 0.2)',
            tension: 0.3,
          },
          {
            label: 'Net',
            data: net,
            borderColor: '#9c27b0',
            backgroundColor: 'rgba(156, 39, 176, 0.2)',
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          tooltip: {
            mode: 'index',
            intersect: false,
          },
          legend: {
            position: 'top',
          },
        },
        interaction: {
          mode: 'nearest',
          axis: 'x',
          intersect: false,
        },
        scales: {
          x: {
            display: true,
            title: { display: true, text: 'Date' },
          },
          y: {
            display: true,
            title: { display: true, text: 'Amount (USD)' },
          },
        },
      },
    });
  }, [data]);

  return <canvas ref={canvasRef} className="earnings-canvas" />;
}
