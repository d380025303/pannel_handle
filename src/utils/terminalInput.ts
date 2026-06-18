type InputEventLike = {
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
};

type ImeInputGuardOptions = {
  duplicateWindowMs?: number;
  now?: () => number;
};

const DEFAULT_DUPLICATE_WINDOW_MS = 120;

function hasComposedText(event: InputEventLike) {
  return Boolean(
    event.isComposing ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromComposition"
  );
}

export function createImeInputGuard(options: ImeInputGuardOptions = {}) {
  const duplicateWindowMs = options.duplicateWindowMs ?? DEFAULT_DUPLICATE_WINDOW_MS;
  const now = options.now ?? (() => performance.now());
  let isComposing = false;
  let compositionId = 0;
  let pendingCommitId: number | undefined;
  let lastForwardedCommit:
    | {
        data: string;
        compositionId: number;
        timestamp: number;
      }
    | undefined;

  const markCompositionActive = () => {
    if (!isComposing) {
      compositionId += 1;
    }
    isComposing = true;
    pendingCommitId = undefined;
  };

  const markCompositionCommitted = () => {
    if (!isComposing) {
      compositionId += 1;
    }
    isComposing = false;
    pendingCommitId = compositionId;
  };

  return {
    handleCompositionStart() {
      markCompositionActive();
    },

    handleCompositionEnd() {
      markCompositionCommitted();
    },

    handleBeforeInput(event: InputEventLike) {
      if (hasComposedText(event)) {
        markCompositionActive();
      }
    },

    handleInput(event: InputEventLike) {
      if (event.inputType === "insertFromComposition") {
        markCompositionCommitted();
        return;
      }

      if (!event.isComposing && event.inputType === "insertCompositionText") {
        markCompositionCommitted();
      }
    },

    shouldForwardData(data: string) {
      const timestamp = now();
      if (isComposing) {
        lastForwardedCommit = {
          data,
          compositionId,
          timestamp
        };
        return true;
      }

      if (pendingCommitId === undefined) {
        return true;
      }

      if (
        lastForwardedCommit &&
        lastForwardedCommit.compositionId === pendingCommitId &&
        lastForwardedCommit.data === data &&
        timestamp - lastForwardedCommit.timestamp <= duplicateWindowMs
      ) {
        return false;
      }

      if (
        lastForwardedCommit &&
        lastForwardedCommit.compositionId === pendingCommitId &&
        timestamp - lastForwardedCommit.timestamp > duplicateWindowMs
      ) {
        pendingCommitId = undefined;
        return true;
      }

      lastForwardedCommit = {
        data,
        compositionId: pendingCommitId,
        timestamp
      };
      return true;
    },

    reset() {
      isComposing = false;
      pendingCommitId = undefined;
      lastForwardedCommit = undefined;
    }
  };
}
