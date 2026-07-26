export function useChatComposer() {
  return {
    chatInput: "",
    chatSending: false,
    chatPendingImages: [],
    setChatInput: () => {},
    setChatPendingImages: () => {},
  };
}
