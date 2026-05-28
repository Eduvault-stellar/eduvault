'use client';

import { createContext, useContext, useState, useCallback } from 'react';
import { useToast } from '@/hooks/useToast';

export const ComparisonContext = createContext(null);

export function ComparisonProvider({ children }) {
  const [comparedItems, setComparedItems] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const toast = useToast();

  const addToComparison = useCallback((material) => {
    // Standardize object properties in case of id/_id mismatch
    const materialId = material._id || material.id;
    if (!materialId) return;

    setComparedItems((prev) => {
      // Avoid duplicate additions
      if (prev.some((item) => (item._id || item.id) === materialId)) {
        toast.show({
          title: 'Already Added',
          message: `"${material.title}" is already in your comparison list.`,
          type: 'info',
          duration: 3000,
        });
        return prev;
      }

      // Enforce the strict maximum boundary of 3 materials
      if (prev.length >= 3) {
        toast.show({
          title: 'Comparison Limit Reached',
          message: 'You can only contrast up to 3 resources side-by-side.',
          type: 'error',
          duration: 4000,
        });
        return prev;
      }

      toast.show({
        title: 'Added to Contrast',
        message: `"${material.title}" added to comparison.`,
        type: 'success',
        duration: 3000,
      });

      return [...prev, material];
    });
  }, [toast]);

  const removeFromComparison = useCallback((id) => {
    setComparedItems((prev) => {
      const removed = prev.find((item) => (item._id || item.id) === id);
      if (removed) {
        toast.show({
          title: 'Removed from Contrast',
          message: `"${removed.title}" removed.`,
          type: 'info',
          duration: 2000,
        });
      }
      return prev.filter((item) => (item._id || item.id) !== id);
    });
  }, [toast]);

  const clearComparison = useCallback(() => {
    setComparedItems([]);
    toast.show({
      title: 'Comparison Cleared',
      message: 'All items removed from contrast.',
      type: 'info',
      duration: 2000,
    });
  }, [toast]);

  const openComparisonModal = useCallback(() => {
    if (comparedItems.length === 0) {
      toast.show({
        title: 'Empty List',
        message: 'Please add at least one material to compare first.',
        type: 'info',
        duration: 3000,
      });
      return;
    }
    setIsModalOpen(true);
  }, [comparedItems, toast]);

  const closeComparisonModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  const value = {
    comparedItems,
    isModalOpen,
    addToComparison,
    removeFromComparison,
    clearComparison,
    openComparisonModal,
    closeComparisonModal,
  };

  return (
    <ComparisonContext.Provider value={value}>
      {children}
    </ComparisonContext.Provider>
  );
}

export function useComparison() {
  const context = useContext(ComparisonContext);
  if (!context) {
    throw new Error('useComparison must be used within a ComparisonProvider');
  }
  return context;
}
