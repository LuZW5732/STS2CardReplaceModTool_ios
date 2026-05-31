import React, { createContext, useState, useContext } from 'react';

const BindingContext = createContext();

export function BindingProvider({ children }) {
  // stagingImages: [{ uri: string, name: string, binding: { cardId: string, crop: { x, y, scale } } | null }]
  const [stagingImages, setStagingImages] = useState([]);
  const [cardsData, setCardsData] = useState([]);

  const scanCards = async () => {
    const { scanCardsData } = require('./cardsScanner');
    const data = await scanCardsData();
    setCardsData(data);
  };

  const addImageToStaging = (uri, name) => {
    setStagingImages(prev => {
      if (prev.some(img => img.uri === uri)) return prev;
      return [...prev, { uri, name, binding: null }];
    });
  };

  const removeImageFromStaging = (uri) => {
    setStagingImages(stagingImages.filter(img => img.uri !== uri));
  };

  const updateBinding = (uri, bindingData) => {
    setStagingImages(stagingImages.map(img => 
      img.uri === uri ? { ...img, binding: bindingData } : img
    ));
  };

  return (
    <BindingContext.Provider value={{ stagingImages, setStagingImages, cardsData, scanCards, addImageToStaging, removeImageFromStaging, updateBinding }}>
      {children}
    </BindingContext.Provider>
  );
}

export const useBindings = () => useContext(BindingContext);
