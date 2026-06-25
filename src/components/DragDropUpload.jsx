import React, { useCallback, useState } from "react";
import { FaImage } from "react-icons/fa";

export default function DragDropUpload({ onFileSelect, error }) {
  const [isDragActive, setIsDragActive] = useState(false);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragActive(false);
      
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith("image/")) {
        onFileSelect(file);
      }
    },
    [onFileSelect]
  );

  const handleChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border-2 border-dashed rounded-lg p-6 text-center transition cursor-pointer flex flex-col items-center justify-center min-h-[140px] ${
        isDragActive
          ? "border-blue-500 bg-blue-50"
          : error
          ? "border-red-500 bg-red-50 hover:border-red-600"
          : "border-gray-300 hover:border-blue-400"
      }`}
      onClick={() => document.getElementById("cover-image-upload").click()}
    >
      <input
        id="cover-image-upload"
        type="file"
        accept="image/*"
        onChange={handleChange}
        className="hidden"
        aria-describedby={error ? "thumb-error" : undefined}
      />
      <FaImage
        className={`text-3xl mb-3 ${
          isDragActive ? "text-blue-500" : "text-gray-400"
        }`}
      />
      <p className="text-sm text-gray-700 font-medium mb-1">
        Drag cover image here or click to browse
      </p>
      <p className="text-xs text-gray-500">Max size: 5MB (16:9 recommended)</p>
    </div>
  );
}
