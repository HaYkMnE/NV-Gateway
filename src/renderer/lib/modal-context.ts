import { createContext, useContext } from 'react';

export interface ModalContextValue {
  openFeedback: () => void;
  openAbout: () => void;
  openDonation: () => void;
}

const defaultModalContext: ModalContextValue = {
  openFeedback: () => {},
  openAbout: () => {},
  openDonation: () => {},
};

export const ModalContext = createContext<ModalContextValue>(defaultModalContext);

export function useModal(): ModalContextValue {
  return useContext(ModalContext);
}
