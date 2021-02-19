import {
  API,
  APIEvent,
  CharacteristicEventTypes,
  CharacteristicProps,
  CharacteristicSetCallback,
  CharacteristicValue,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig,
} from "homebridge";
import {ViessmannConfig, vcontrolAction, vcontrolQueueItem, Heizkreis} from './configTypes';
const EventEmitter = require('events');
const VControl = require("vcontrol")
const version = require('../package.json').version; 

const PLUGIN_NAME = "homebridge-viessmann-control"; // same as in package json
const PLATFORM_NAME = "Viessmann-control"; // same as in config.json

const VCONTROL_EVENT_NAME = "event";

/*
 * IMPORTANT NOTICE
 *
 * One thing you need to take care of is, that you never ever ever import anything directly from the "homebridge" module (or the "hap-nodejs" module).
 * The above import block may seem like, that we do exactly that, but actually those imports are only used for types and interfaces
 * and will disappear once the code is compiled to Javascript.
 * In fact you can check that by running `npm run build` and opening the compiled Javascript file in the `dist` folder.
 * You will notice that the file does not contain a `... = require("homebridge");` statement anywhere in the code.
 *
 * The contents of the above import statement MUST ONLY be used for type annotation or accessing things like CONST ENUMS,
 * which is a special case as they get replaced by the actual value and do not remain as a reference in the compiled code.
 * Meaning normal enums are bad, const enums can be used.
 *
 * You MUST NOT import anything else which remains as a reference in the code, as this will result in
 * a `... = require("homebridge");` to be compiled into the final Javascript code.
 * This typically leads to unexpected behavior at runtime, as in many cases it won't be able to find the module
 * or will import another instance of homebridge causing collisions.
 *
 * To mitigate this the {@link API | Homebridge API} exposes the whole suite of HAP-NodeJS inside the `hap` property
 * of the api object, which can be acquired for example in the initializer function. This reference can be stored
 * like this for example and used to access all exported variables and classes from HAP-NodeJS.
 */
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

  private vControlC:any;

  private vControld_Running:boolean = false;
  
  readonly heatingCircleNames:Heizkreis[] = [Heizkreis.HK1, Heizkreis.HK2];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;

    this.config = config as unknown as ViessmannConfig;

    this.vcontroldIP = this.config.vcontroldIP || '127.0.0.1';
    this.vcontroldPort = this.config.vcontroldPort || 3002;

    this.vControlC = new VControl({
      host: this.vcontroldIP,
      port: this.vcontroldPort,
      debug: process.argv.includes('-D') || process.argv.includes('--debug')
    })

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
  }

  async processvControl() {
    if(this.vControld_Running) return;
    this.vControld_Running = true;

    this.log.debug("Queue size: "+vcontrolQueue.length);
    let vcontrolQueueItem = vcontrolQueue.shift();
    this.log.debug("Queue size: "+vcontrolQueue.length);
    if(vcontrolQueueItem) {
      try {
        await this.vControlC.connect();
      } catch(err) {
        this.log.error(err);
        return;
      }
    }

    while(vcontrolQueueItem) {

      this.log.debug(vcontrolQueueItem.cmd);
      try {
        if(vcontrolQueueItem.action == vcontrolAction.GET) {

          let data = await this.vControlC.getData(vcontrolQueueItem.cmd);
          this.log.debug("received data for cmd: "+vcontrolQueueItem.cmd+": "+data);
  
          this.log.debug("callback");
          vcontrolQueueItem.cb(data);
        }
        else {
          await this.vControlC.connect();
  
          await this.vControlC.setData(vcontrolQueueItem.cmd, vcontrolQueueItem.value);
          vcontrolQueueItem.cb();
  
        }

      } catch(err) {
        this.log.error(err);
        vcontrolQueueItem.cb(null);

      }
      vcontrolQueueItem = vcontrolQueue.shift();
      this.log.debug("Queue size: "+vcontrolQueue.length);

    }
    try {
      await this.vControlC.close();
    } catch(err) {
      this.log.error(err);
    }

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
    //for(let entry in this.heatingCircles) {
     this.heatingCircleNames.forEach((entry:Heizkreis) => { 
       let handler = new ViessmannHandler(entry, this.log);
       
       this.log.info("Configure service for: ", entry);
      
        let service = accessory.getServiceById(hap.Service.Thermostat, entry);
        if(service) this.log.debug("found service ==> remove:", service?.UUID)
        if(service) accessory.removeService(service);
        
        service = new hap.Service.Thermostat(entry, entry);
        this.log.debug("add new thermostst service with UUID", service.UUID);

        // create handlers for required characteristics
        service.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
         .on(CharacteristicEventTypes.GET, (callback: CharacteristicSetCallback) => {
          handler.handleCurrentHeatingCoolingStateGet(callback);
         });

        service.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
          .on(CharacteristicEventTypes.GET, (callback: CharacteristicSetCallback) => {
            handler.handleTargetHeatingCoolingStateGet(callback)
          })
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            handler.handleTargetHeatingCoolingStateSet(state, callback);
          })
          .props.validValues = [0, 1]; //only OFF and HEAT are supported

        service.getCharacteristic(hap.Characteristic.CurrentTemperature)
          .on(CharacteristicEventTypes.GET, (callback: CharacteristicSetCallback) => {
            handler.handleCurrentTemperatureGet(callback);
            });

        service.getCharacteristic(hap.Characteristic.TargetTemperature)
          .on(CharacteristicEventTypes.GET, (callback: CharacteristicSetCallback) => {
            handler.handleTargetTemperatureGet(callback)
          })
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            handler.handleTargetTemperatureSet(state, callback);
          });
          let props:CharacteristicProps = service.getCharacteristic(hap.Characteristic.TargetTemperature).props;
          props.minValue = 15;
          props.maxValue = 25;
          props.minStep = 1;

        service.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
          .on(CharacteristicEventTypes.GET, (callback: CharacteristicSetCallback) => {
            handler.handleTemperatureDisplayUnitsGet(callback);
          })
          .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            handler.handleTemperatureDisplayUnitsSet(state, callback);
          })
          .props.validValues = [0];

        accessory.addService(service);
    });
    this.accessories.push(accessory);
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

class ViessmannHandler{
  hk:Heizkreis;
  log: Logging;
  targetState = 1;

  constructor(hk:Heizkreis, log:Logging) {
    this.hk = hk;
    this.log = log;
  }

  handleCurrentHeatingCoolingStateGet(callback: any) {
    this.log.debug('Triggered GET CurrentHeatingCoolingState');
    this.log.debug("name HK: "+this.hk);
    let cmd = this.hk == Heizkreis.HK1 ? "getVitoBetriebsartM1" :"getVitoBetriebsartM2";

    let item: vcontrolQueueItem = {action:vcontrolAction.GET, cmd: cmd, cb: (val: any) => {
      this.log.debug("CurrentHeatingCoolingState:"+val);
      let currentValue = (val >= 2) ? 1:0;
      
      callback(null, currentValue);
      }
    };
    vcontrolQueue.push(item);
    myEmitter.emit(VCONTROL_EVENT_NAME);
  }
  
    handleTargetHeatingCoolingStateGet(callback : any) {
      this.log.debug('Triggered GET TargetHeatingCoolingState');
      this.log.debug("%d", this.targetState);
      
      callback(null, this.targetState);
    }

    async handleTargetHeatingCoolingStateSet(value: any, callback: any) {
      this.log.debug('Triggered SET TargetHeatingCoolingState:', value);
      let cmd = this.hk == Heizkreis.HK1 ? "setVitoBetriebsartM1" :"setVitoBetriebsartM2";
      this.targetState = value;
      let mappedValue = 2;

      if(value == 1) mappedValue = 2;
      else if (value == 0) {
        if(this.hk == Heizkreis.HK1) mappedValue = 1;
        else if(this.hk == Heizkreis.HK2) mappedValue = 0;
      }
      let item: vcontrolQueueItem = {action:vcontrolAction.GET, value: mappedValue, cmd: cmd, cb: () => {
        callback(null);
        }
      };
      vcontrolQueue.push(item);
      myEmitter.emit(VCONTROL_EVENT_NAME);
  
      callback(null);
    }
  
    handleCurrentTemperatureGet(callback: any) {
      this.log.debug('Triggered GET CurrentTemperature');
      const currentValue = 21;
  
      callback(null, currentValue);
    }
  
    async handleTargetTemperatureGet(callback: any) {
      this.log.debug('Triggered GET TargetTemperature');
      let cmd = this.hk == Heizkreis.HK1 ? "getTempRaumNorSollM1" :"getTempRaumNorSollM2";
      let item: vcontrolQueueItem = {action:vcontrolAction.GET, cmd: cmd, cb: (val: any) => {
        this.log.info("received TargetTemperature: "+val);
        let currentValue = val as number;
        callback(null, currentValue);
        }
      };
      vcontrolQueue.push(item);
      myEmitter.emit(VCONTROL_EVENT_NAME);
    }

    handleTargetTemperatureSet(value: any, callback: any) {
      this.log.debug('Triggered SET TargetTemperature:', value);
      let cmd = this.hk == Heizkreis.HK1 ? "setTempRaumNorSollM1" :"setTempRaumNorSollM2";
  
      let item: vcontrolQueueItem = {action:vcontrolAction.SET, value: value, cmd: cmd, cb: () => {
        this.log.info("set TargetTemperature success: " +value);
        callback(null);
      }
    };
    vcontrolQueue.push(item);
    myEmitter.emit(VCONTROL_EVENT_NAME);
    }

    handleTemperatureDisplayUnitsGet(callback: any) {
      this.log.debug('Triggered GET TemperatureDisplayUnits');
      const currentValue = 0;
  
      callback(null, currentValue);
    }

    handleTemperatureDisplayUnitsSet(value: any, callback: any) {
      this.log.debug('Triggered SET TemperatureDisplayUnits:', value);
  
      callback(null);
    }
}