// From https://github.com/NixOS/nix/blob/6a8f1b548fc85af7e065feee93920839ec94fa40/src/libutil/logging.hh

export enum ActivityType {
    Unknown = 0,
    CopyPath = 100,
    FileTransfer = 101,
    Realise = 102,
    CopyPaths = 103,
    Builds = 104,
    Build = 105,
    OptimiseStore = 106,
    VerifyPaths = 107,
    Substitute = 108,
    QueryPathInfo = 109,
    PostBuildHook = 110,
    BuildWaiting = 111,
}

export enum ResultType {
    FileLinked = 100,
    BuildLogLine = 101,
    UntrustedPath = 102,
    CorruptedPath = 103,
    SetPhase = 104,
    Progress = 105,
    SetExpected = 106,
    PostBuildLogLine = 107,
}

export interface LogAction {
    level: number,
    msg: string,
}

export interface StartAction {
    id: number,
    level: number,
    type: ActivityType,
    text: string,
    fields: any,
}

export interface StopAction {
    id: number,
}

export interface ResultAction {
    id: number,
    type: ResultType,
    fields: any,
}