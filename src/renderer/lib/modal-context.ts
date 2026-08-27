import React, { createContext, useContext } from 'react';

export interface ModalContextValue {
  openAbout: () => void;
  openFeedback: () => void;
  openSettings: () => void;
}

export const ModalContext = createContext<ModalContextValue>({
  openAbout: () => {},
  openFeedback: () => {},
  openSettings: () => {},
});

export const useModalContext = () => useContext(ModalContext);
