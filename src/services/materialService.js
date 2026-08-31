import { apiClient } from '@/lib/api/apiClient';
import {
  publishMaterial as generatedPublishMaterial,
  closeMaterial as generatedCloseMaterial,
  cancelMaterial as generatedCancelMaterial,
} from '@/lib/api/generated/client';

export const materialService = {
  getMarketplaceMaterials: async (params = {}) => {
    const searchParams = new URLSearchParams();
    if (params.cursor) searchParams.set('cursor', params.cursor);
    if (params.search) searchParams.set('search', params.search);
    if (params.subject) searchParams.set('subject', params.subject);
    if (params.category) searchParams.set('category', params.category);
    if (params.level) searchParams.set('level', params.level);
    if (params.sortBy) searchParams.set('sortBy', params.sortBy);
    if (params.minPrice) searchParams.set('minPrice', params.minPrice);
    if (params.maxPrice) searchParams.set('maxPrice', params.maxPrice);
    if (params.creator) searchParams.set('creator', params.creator);
    if (params.usageRights) searchParams.set('usageRights', params.usageRights);
    if (params.pageSize) searchParams.set('pageSize', params.pageSize);
    return apiClient(`/api/market-materials?${searchParams.toString()}`);
  },

  getMaterialDetail: async (id) => {
    return apiClient(`/api/market-materials?id=${id}`);
  },

  getMaterialFeedback: async (id) => {
    return apiClient(`/api/materials/${id}/feedback`);
  },

  getUserMaterials: async () => {
    return apiClient('/api/materials');
  },

  createMaterial: async (materialData) => {
    return apiClient('/api/materials', { body: materialData });
  },

  uploadFile: async (formData) => {
    return apiClient('/api/upload', {
      body: formData,
      headers: { 'Content-Type': undefined },
      method: 'POST'
    });
  },

  getDownloadUrl: async (id) => {
    return apiClient(`/api/materials/download/${id}`);
  },

  updateMaterial: async (id, updateData) => {
    return apiClient(`/api/materials?id=${id}`, {
      method: 'PUT',
      body: updateData,
    });
  },

  submitMaterialFeedback: async (id, feedbackData) => {
    return apiClient(`/api/materials/${id}/feedback`, {
      method: 'POST',
      body: feedbackData,
    });
  },

  getMaterialHistory: async (id) => {
    return apiClient(`/api/materials/history?id=${id}`);
  },

  reportMaterial: async (id, reportData) => {
    return apiClient(`/api/materials/${id}/report`, {
      method: 'POST',
      body: reportData,
    });
  },

  getTrendingMaterials: async (params = {}) => {
    const searchParams = new URLSearchParams({ ...params, sort: 'trending' });
    return apiClient(`/api/market-materials?${searchParams.toString()}`);
  },

  publishMaterial: async (id, { contractId } = {}) => {
    return generatedPublishMaterial({ id, body: contractId ? { contractId } : {} });
  },

  closeMaterial: async (id, { reason } = {}) => {
    return generatedCloseMaterial({ id, body: reason ? { reason } : {} });
  },

  cancelMaterial: async (id, { reason } = {}) => {
    return generatedCancelMaterial({ id, body: reason ? { reason } : {} });
  },
};

