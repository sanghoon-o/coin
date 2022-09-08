export class CommonUtils {
  static setAddRate (addRate: string | undefined) {
    return (!addRate) ? 1.0 :
      (parseFloat(addRate) < 0 || parseFloat(addRate) > 1)
        ? 1.0 : parseFloat(addRate);
  }
  
  static setAddTakeProfitCount (addTakeProfitCount: string | undefined) {
    return (!addTakeProfitCount) ? 0 : parseInt(addTakeProfitCount);
  }
}