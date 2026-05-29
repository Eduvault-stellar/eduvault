"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/hooks/useWallet";
import { useUserProfile, useCreateProfile, useUpdateProfile } from "@/hooks/api/useProfile";
import { motion, AnimatePresence } from "framer-motion";
import { FaUser, FaPen, FaCamera, FaSpinner, FaCheckCircle } from "react-icons/fa";

export default function ProfileOnboarding() {
  const { address, isConnected } = useWallet();
  const { data: profileData, isLoading: profileLoading } = useUserProfile(address);
  const createProfile = useCreateProfile();
  const updateProfile = useUpdateProfile();

  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    fullName: "",
    bio: "",
    avatarUrl: "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const profile = profileData?.user;
  const exists = profileData?.exists;

  useEffect(() => {
    if (profile) {
      setFormData({
        fullName: profile.fullName || "",
        bio: profile.bio || "",
        avatarUrl: profile.avatarUrl || "",
      });
    }
  }, [profile]);

  const handleChange = useCallback((field) => (e) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    setSaved(false);
    setError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!address || !formData.fullName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (exists) {
        await updateProfile.mutateAsync({
          displayName: formData.fullName,
          bio: formData.bio,
          avatarUrl: formData.avatarUrl,
        });
      } else {
        await createProfile.mutateAsync({
          fullName: formData.fullName,
          email: profile?.email || `${address.toLowerCase()}@eduvault.user`,
          walletAddress: address,
          bio: formData.bio,
          avatarUrl: formData.avatarUrl,
        });
      }
      setSaved(true);
      setShowForm(false);
    } catch (err) {
      setError(err?.message || "Failed to save profile");
    } finally {
      setSaving(false);
    }
  }, [address, formData, exists, profile, createProfile, updateProfile]);

  if (!isConnected || profileLoading) return null;

  if (exists && !showForm && profile) {
    return (
      <div className="flex items-center gap-4 p-4 bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center overflow-hidden">
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <FaUser className="text-indigo-500 text-lg" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900 truncate">{profile.fullName || "Creator"}</p>
          {profile.bio && <p className="text-xs text-gray-500 truncate">{profile.bio}</p>}
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 text-sm text-indigo-600 hover:text-indigo-700 font-medium px-3 py-1.5 rounded-lg hover:bg-indigo-50 transition-colors"
        >
          <FaPen size={12} />
          Edit
        </button>
      </div>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        className="p-5 bg-white rounded-xl border border-gray-200 shadow-sm"
      >
        <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
          <FaCamera className="text-indigo-500" />
          {exists ? "Edit Profile" : "Complete Your Profile"}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Display Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={formData.fullName}
              onChange={handleChange("fullName")}
              placeholder="Your display name"
              maxLength={120}
              className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Bio</label>
            <textarea
              value={formData.bio}
              onChange={handleChange("bio")}
              placeholder="Tell others about yourself"
              maxLength={1000}
              rows={3}
              className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Avatar URL</label>
            <input
              type="url"
              value={formData.avatarUrl}
              onChange={handleChange("avatarUrl")}
              placeholder="https://example.com/avatar.jpg"
              maxLength={2048}
              className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || !formData.fullName.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-60 transition-colors"
            >
              {saving ? (
                <FaSpinner className="animate-spin" size={14} />
              ) : saved ? (
                <FaCheckCircle size={14} />
              ) : null}
              {saving ? "Saving..." : saved ? "Saved!" : "Save Profile"}
            </button>
            {exists && (
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 font-medium"
              >
                Cancel
              </button>
            )}
          </div>

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
