import {
  API,
  APIEvent,
  CharacteristicProps,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig,
} from "homebridge";
import {ViessmannConfig, vcontrolAction, vcontrolQueueItem, Heizkreis, cache} from './configTypes';

const EventEmitter = require('events');
const VControl = require("vcontrol")
const version = require('../package.json').version; 

const PLUGIN_NAME = "homebridge-viessmann-control"; // same as in package json
const PLATFORM_NAME = "Viessmann-control"; // same as in config.json

const VCONTROL_EVENT_NAME = "event";

const updateIntervalMinutes = 30;

let hap: HAP;
let Accessory: typeof PlatformAccessory;
class MyEmitter extends EventEmitter {}

let myEmitter = new MyEmitter();
let vcontrolQueue :vcontrolQueueItem []= [];

export = (api: API) => {
  hap = api.hap;
  Accessory = api.platformAccessory;
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, ViessmanControl);
};

class ViessmanControl implements DynamicPlatformPlugin {

  readonly log: Logging;
  private readonly api: API;
  private readonly config: ViessmannConfig;

  private readonly accessories: PlatformAccessory[] = [];

  private readonly vcontroldIP: string;
  private readonly vcontroldPort: number;
  private readonly debug: boolean;

  private vControlC:any;

  private timer: NodeJS.Timeout;
  private handlerList:ViessmannHandler[] = [];

  private vControld_Running:boolean = false;
  
  readonly heatingCircleNames:Heizkreis[] = [Heizkreis.HK1, Heizkreis.HK2];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;

    this.config = config as unknown as ViessmannConfig;

    this.vcontroldIP = this.config.vcontroldIP || '127.0.0.1';
    this.vcontroldPort = this.config.vcontroldPort || 3002;
    this.debug = this.config.debug  || false;

    this.vControlC = new VControl({
      host: this.vcontroldIP,
      port: this.vcontroldPort,
      debug: this.debug
    })
    //process.argv.includes('-D') || process.argv.includes('--debug')

    myEmitter.on(VCONTROL_EVENT_NAME, () => {
      this.log.debug('VCONTROL EVENT!');
      this.processvControl();
    });

    log.info(PLATFORM_NAME + " finished initializing!");

    /*
     * When this event is fired, homebridge restored all cached accessories from disk and did call their respective
     * `configureAccessory` method for all of them. Dynamic Platform plugins should only register new accessories
     * after this event was fired, in order to ensure they weren't added to homebridge already.
     * This event can also be used to start discovery of new accessories.
     */
    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this));
    api.on(APIEvent.SHUTDOWN, this.shutdown.bind(this));
  }

  async processvControl() {
    if(this.vControld_Running) {
      this.log.debug("vcontrol already running. returning");
      return;
    }
    this.log.debug("vcontrol running true");
    this.vControld_Running = true;

    let vcontrolQueueItem = vcontrolQueue.shift();
    if(vcontrolQueueItem) {
      try {
        await this.vControlC.connect();
      } catch(e) {
        let err = e as Error;
        this.log.error(err.message);
        vcontrolQueueItem.cb(null);
        this.log.debug("vcontrol running false");
        this.vControld_Running = false;
        return;
      }
    }

    while(vcontrolQueueItem) {

      this.log.debug("Executing cmd: "+ vcontrolQueueItem.cmd);
      //try {
        if(vcontrolQueueItem.action == vcontrolAction.GET) {

          await this.vControlC.getData(vcontrolQueueItem.cmd)
          .then((data:any) => {
            this.log.debug("Received data for cmd: "+vcontrolQueueItem!.cmd+": "+data);
            vcontrolQueueItem!.cb(data);
          })
          .catch((e:Error) => {
            let err = e as Error;
            this.log.error(err.message);
            vcontrolQueueItem!.cb(null);
          });
        }
        else {
          await this.vControlC.setData(vcontrolQueueItem.cmd, vcontrolQueueItem.value)
          .then(() => {
            this.log.debug("Setting data for cmd: "+vcontrolQueueItem!.cmd+" done.");
            vcontrolQueueItem!.cb();
          })
          .catch((e:Error) => {
            let err = e as Error;
            this.log.error(err.message);
            vcontrolQueueItem!.cb();
          });
        }
     /* } catch(e) {
        let err = e as Error;
        this.log.error(err.message);
        vcontrolQueueItem.cb(null);
      }
      */
      vcontrolQueueItem = vcontrolQueue.shift();
    }
    try {
      await this.vControlC.close();
    } catch(e) {
      let err = e as Error;
      this.log.error(err.message);
    }
    this.log.debug("vcontrol running false");

    this.vControld_Running = false;
  }
  /*
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory): void {
      this.log("Configuring accessory %s", accessory.displayName);

      accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
          this.log("%s identified!", accessory.displayName);
      });

      const accInfo = accessory.getService(hap.Service.AccessoryInformation);
      if (accInfo) {
          accInfo.setCharacteristic(hap.Characteristic.Manufacturer, this.config.manufacturer || 'Viessmann');
          accInfo.setCharacteristic(hap.Characteristic.Model, this.config.model || 'unknown');
          accInfo.setCharacteristic(hap.Characteristic.SoftwareRevision, version);
      }
      this.heatingCircleNames.forEach((entry:Heizkreis) => {

        let handler = new ViessmannHandler(entry, this.log, this.api);
        this.handlerList.push(handler);
        this.log.info("Configure service for: ", entry);
        
        let service_old = accessory.getServiceById(hap.Service.Thermostat, entry);
        if(service_old) accessory.removeService(service_old);
        if(service_old) this.log.debug("found service ==> remove:", service_old?.UUID);

        let service = new hap.Service.Thermostat(entry, entry);   
        this.log.debug("add new thermostst service with UUID", service.UUID);
  
        service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
        //.onGet(handler.handleCurrentHeatingCoolingStateGet.bind(handler));
        .onGet(handler.currentHeatingCoolingStateFromCache.bind(handler));

        service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
        //.onGet(handler.handleTargetHeatingCoolingStateGet.bind(handler))
        .onGet(handler.targetHeatingCoolingStateFromCache.bind(handler))
        .onSet(handler.handleTargetHeatingCoolingStateSet.bind(handler))
        .props.validValues = [0, 1]; //only OFF and HEAT are supported

        service.getCharacteristic(hap.Characteristic.CurrentTemperature)
        //.onGet(handler.handleCurrentTemperatureGet.bind(handler));
        .onGet(handler.currentTemperatureFromCache.bind(handler));

        service.getCharacteristic(hap.Characteristic.TargetTemperature)
        //.onGet(handler.handleTargetTemperatureGet.bind(handler))
        .onGet(handler.targetTemperatureFromCache.bind(handler))
        .onSet(handler.handleTargetTemperatureSet.bind(handler))
        let props:CharacteristicProps = service.getCharacteristic(hap.Characteristic.TargetTemperature).props;
        props.minValue = 15;
        props.maxValue = 25;
        props.minStep = 1;
          
        service.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
        //.onGet(handler.handleTemperatureDisplayUnitsGet.bind(handler))
        .onGet(handler.temperatureDisplayUnitFromCache.bind(handler))
        .onSet(handler.handleTemperatureDisplayUnitsSet.bind(handler))
        .props.validValues = [0];

        accessory.addService(service);
    });
    this.accessories.push(accessory);

    this.timer = setInterval(() => {
        this.cycleUpdate();
    }, 1000*60*updateIntervalMinutes);

    this.cycleUpdate();
  }

  shutdown(): void {
      this.log.info("Shutdown");
      if(this.timer) clearTimeout(this.timer);
  }

  cycleUpdate(): void {
    this.log.info("Start cyclic update")
      this.handlerList.forEach((handler:ViessmannHandler) => {
          handler.update();
    });
  }

  didFinishLaunching(): void {
    this.log.info("didFinishLaunching");

    const uuid = hap.uuid.generate(this.config.model);
  
    if (!this.accessories.find((x: PlatformAccessory) => x.UUID === uuid)) {
        this.log.info("Create new accessory, not cached previously", uuid);
        const accessory = new Accessory(this.config.model, uuid);
        this.configureAccessory(accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  };
}

class ViessmannHandler {
  hk:Heizkreis;
  log: Logging;
  targetState = 1;
  api: API;
  cache: cache = {currentTemp: 21, targetTemp:21, currentHeatingCoolingState: 0, targetHeatingCoolingState: 0, unit:0};

  constructor(hk:Heizkreis, log:Logging, api:API) {
    this.hk = hk;
    this.log = log;
    this.api = api;
    this.cache 
  }

  update(): void {
    this.handleCurrentHeatingCoolingStateGet().then(val => {
      this.cache.currentHeatingCoolingState = val as number;
    })
    .catch((e:Error) => {
      this.log.error(e.message);
    });
    this.handleTargetHeatingCoolingStateGet().then(val => {
      this.cache.targetHeatingCoolingState = val as number;
    })
    .catch((e:Error) => {
      this.log.error(e.message);
    });
    this.handleCurrentTemperatureGet().then(val => {
      this.cache.currentTemp = val as number;
    })
    .catch((e:Error) => {
      this.log.error(e.message);
    });
    this.handleTargetTemperatureGet().then(val => {
      this.cache.targetTemp = val as number;
    })
    .catch((e:Error) => {
      this.log.error(e.message);
    });
    this.handleTemperatureDisplayUnitsGet().then(val => {
      this.cache.unit = val as number;
    })
    .catch((e:Error) => {
      this.log.error(e.message);
    });
  }

  currentHeatingCoolingStateFromCache(): CharacteristicValue {
    return this.cache.currentHeatingCoolingState;
  }
  targetHeatingCoolingStateFromCache(): CharacteristicValue {
    return this.cache.targetHeatingCoolingState;
  }
  currentTemperatureFromCache(): CharacteristicValue {
    return this.cache.currentTemp;
  }
  targetTemperatureFromCache(): CharacteristicValue {
    return this.cache.targetTemp;
  }
  temperatureDisplayUnitFromCache(): CharacteristicValue {
    return this.cache.unit;
  }

  handleCurrentHeatingCoolingStateGet() : Promise<CharacteristicValue>   {
    this.log.debug('Triggered GET CurrentHeatingCoolingState');
    let api = this.api;

    this.log.debug("name HK: "+this.hk);
    let cmd = this.hk == Heizkreis.HK1 ? "getVitoBetriebsartM1" :"getVitoBetriebsartM2";

    var p1 = new Promise<number>(
      function(resolve, reject) {

        let item: vcontrolQueueItem = {action:vcontrolAction.GET, cmd: cmd, cb: (val: any) => {
          if(val == undefined || val == null) reject("Could not process request");
          let currentValue = (val >= 2) ? 1:0;
          resolve(currentValue);
          }
        }
        vcontrolQueue.push(item);
        myEmitter.emit(VCONTROL_EVENT_NAME);
      });
    return p1;
  }


  handleTargetHeatingCoolingStateGet() : Promise<CharacteristicValue>{  
    let targetState = this.targetState;
    this.log.debug('Triggered GET TargetHeatingCoolingState');
    this.log.debug("%d", this.targetState);

    var p1 = new Promise<number>(
      function(resolve, reject) {
        resolve(targetState);
      });
    return p1;
  }

  handleCurrentTemperatureGet() : Promise<CharacteristicValue> {
    this.log.debug('Triggered GET CurrentTemperature');
    const currentValue = 21;

    var p1 = new Promise<number>(
      function(resolve, reject) {
        resolve(currentValue);
      });
    return p1;
  }

  handleTargetTemperatureGet() :Promise<CharacteristicValue> {
      let log = this.log;
      let hk = this.hk;

      var p1 = new Promise<number>(
      function(resolve, reject) {
        let cmd = hk == Heizkreis.HK1 ? "getTempRaumNorSollM1" :"getTempRaumNorSollM2";
        let item: vcontrolQueueItem = {action:vcontrolAction.GET, cmd: cmd, cb: (val: any) => {
          if(val == undefined || val == null) reject("Could not process request");
          log.debug(hk+ ": received TargetTemperature: "+val);
          let currentValue = val as number;
          resolve(currentValue);
          }
        }
        vcontrolQueue.push(item);
        myEmitter.emit(VCONTROL_EVENT_NAME);
      });
      return p1;
  }

  handleTemperatureDisplayUnitsGet(): Promise<CharacteristicValue> {
    this.log.debug('Triggered GET TemperatureDisplayUnits');
    const currentValue = 0;

    var p1 = new Promise<number>(
      function(resolve, reject) {
        resolve(0);
      });
    return p1;
  }

  handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.log.debug('Triggered SET TargetHeatingCoolingState:', value);
    let cmd = this.hk == Heizkreis.HK1 ? "setVitoBetriebsartM1" :"setVitoBetriebsartM2";
    this.targetState = value as number;
    let mappedValue = 2;
    

    if(value == 1) mappedValue = 2;
    else if (value == 0) {
      if(this.hk == Heizkreis.HK1) mappedValue = 1;
      else if(this.hk == Heizkreis.HK2) mappedValue = 0;
    }
    let item: vcontrolQueueItem = {action:vcontrolAction.SET, value: mappedValue, cmd: cmd, cb: () => {
      this.log.info("Set TargetHeatingCoolingState done.");
      this.cache.targetHeatingCoolingState = value as number;
      }
    };
    vcontrolQueue.push(item);
    myEmitter.emit(VCONTROL_EVENT_NAME);
  }

  handleTargetTemperatureSet(value: CharacteristicValue) {
    this.log.debug('Triggered SET TargetTemperature: %d', value as number);
    let cmd = this.hk == Heizkreis.HK1 ? "setTempRaumNorSollM1" :"setTempRaumNorSollM2";
    

    let item: vcontrolQueueItem = {action:vcontrolAction.SET, value: value as number, cmd: cmd, cb: () => {
        this.log.info("Set TargetTemperature done.");
        this.cache.targetTemp = value as number;
      }
    };
    vcontrolQueue.push(item);
    myEmitter.emit(VCONTROL_EVENT_NAME);
  }

  handleTemperatureDisplayUnitsSet(value: CharacteristicValue) {
    this.log.debug('Triggered SET TemperatureDisplayUnits: ' + value);
  } 
}