import { Logging } from "homebridge";

export type ViessmannConfig = {
    name: string;
    manufacturer: string;
    model: string;
    vcontroldIP: string;
    vcontroldPort: number;

  };


  export enum vcontrolAction  {
    GET,
    SET
  }


  export enum Heizkreis {
    HK1 ="HK1",
    HK2 = "HK2"
  }

  export type vcontrolQueueItem = {
    action: vcontrolAction;
    value?: any;
    cmd: string;
    cb: (val?:any) => void;
  }

  export type heatingCircle = {
    name: string;
    //class: ViessmannHandler;
    log:Logging;

  }
    /*
  export class ViessmannHandler {

    handleCurrentHeatingCoolingStateGet: any;
    handleTargetHeatingCoolingStateGet: any;
    handleTargetHeatingCoolingStateSet: (value:any, callback:any) => void;
    handleCurrentTemperatureGet: any;
    handleTargetTemperatureGet: any;
    handleTargetTemperatureSet: any;
    handleTemperatureDisplayUnitsGet: any;
    handleTemperatureDisplayUnitsSet: any;
  
  };  */
  