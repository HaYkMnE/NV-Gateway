import { createContext, useContext } from 'react';

export type ActiveModal = 'feedback' | 'about' | 'donation' | 'send-errors' | null;
export type ModalRequest = number;

export interface ModalContextValue {
  activeModal: ActiveModal;
  activeModalRequest: ModalRequest | null;
  beginModalRequest: () => ModalRequest;
  isCurrentModalRequest: (request: ModalRequest) => boolean;
  openFeedback: (request?: ModalRequest) => boolean;
  openAbout: (request?: ModalRequest) => boolean;
  openDonation: (request?: ModalRequest) => boolean;
  openSendErrors: (request?: ModalRequest) => boolean;
  closeModal: (expected: Exclude<ActiveModal, null>, request: ModalRequest) => void;
}

const defaultModalContext: ModalContextValue = {
  activeModal: null,
  activeModalRequest: null,
  beginModalRequest: () => 0,
  isCurrentModalRequest: () => false,
  openFeedback: () => false,
  openAbout: () => false,
  openDonation: () => false,
  openSendErrors: () => false,
  closeModal: () => {},
};

export const ModalContext = createContext<ModalContextValue>(defaultModalContext);

export function useModal(): ModalContextValue {
  return useContext(ModalContext);
}
