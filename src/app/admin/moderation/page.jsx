"use client";

import React, { useState, useEffect } from 'react';
import './moderation.css';

/**
 * This client page is rendered inside the server-side /admin layout
 * (src/app/admin/layout.jsx), which verifies the session against the profile
 * database before allowing any /admin UI to render. Client-side guards cannot
 * authorize users, so no guard is placed here (see #134).
 */

/**
 * Mock fetch for flagged items – in real code this would call the backend.
 */
const fetchFlagged = async () => {
  // Sample data
  return [
    { id: 1, title: 'Document A.pdf', reason: 'Inappropriate content', reporter: 'user123' },
    { id: 2, title: 'ImageB.png', reason: 'Copyright violation', reporter: 'user456' },
    { id: 3, title: 'VideoC.mp4', reason: 'Harassment', reporter: 'user789' },
  ];
};

function ModerationDashboard() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFlagged().then(data => {
      setItems(data);
      setLoading(false);
    });
  }, []);

  const handleAction = (id, action) => {
    // In real app, send request to backend with auth
    alert(`Action "${action}" applied to item #${id}`);
    // Remove item from UI for demo purposes
    setItems(prev => prev.filter(i => i.id !== id));
  };

  if (loading) return <p className="loading">Loading flagged content...</p>;

  return (
    <section className="admin-moderation">
      <h2 className="title">Content Moderation Dashboard</h2>
      {items.length === 0 ? (
        <p className="empty">No flagged items at the moment.</p>
      ) : (
        <table className="mod-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Reason</th>
              <th>Reporter</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.title}</td>
                <td>{item.reason}</td>
                <td>{item.reporter}</td>
                <td className="action-cell">
                  <button className="action-btn approve" onClick={() => handleAction(item.id, 'Approve')}>Approve</button>
                  <button className="action-btn deny" onClick={() => handleAction(item.id, 'Deny')}>Deny</button>
                  <button className="action-btn suspend" onClick={() => handleAction(item.id, 'Suspend')}>Suspend</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
